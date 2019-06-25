import { join, dirname, basename } from 'path'
import { createSelector } from 'redux-bundler'
import { getDownloadLink, getShareableLink } from '../lib/files'
import countDirs from '../lib/count-dirs'
import { sortByName, sortBySize } from '../lib/sort'

const isMac = navigator.userAgent.indexOf('Mac') !== -1
export const MFS_PATH = '/home'

export const ACTIONS = {
  FETCH: 'FETCH',
  MOVE: 'MOVE',
  COPY: 'COPY',
  DELETE: 'DELETE',
  MAKE_DIR: 'MAKEDIR',
  WRITE: 'WRITE',
  DOWNLOAD_LINK: 'DOWNLOADLINK',
  ADD_BY_PATH: 'ADDBYPATH'
}

export const sorts = {
  BY_NAME: 'name',
  BY_SIZE: 'size'
}

const ignore = [
  '.DS_Store',
  'thumbs.db',
  'desktop.ini'
]

const make = (basename, action, options = {}) => (...args) => async (args2) => {
  const id = Symbol(basename)
  const { dispatch, getIpfs, store } = args2
  dispatch({ type: `FILES_${basename}_STARTED`, payload: { id } })

  let data

  if (options.mfsOnly) {
    if (!store.selectFilesIsMfs()) {
      // TODO: musn't be here
      return
    }
  }

  try {
    data = await action(getIpfs(), ...args, id, args2)
    dispatch({ type: `FILES_${basename}_FINISHED`, payload: { id, ...data } })

    // Rename specific logic
    if (basename === ACTIONS.MOVE) {
      const src = args[0][0]
      const dst = args[0][1]

      if (src === store.selectFiles().path) {
        await store.doUpdateHash(`/files${dst}`)
      }
    }

    // Delete specific logic
    if (basename === ACTIONS.DELETE) {
      const src = args[0][0]

      let path = src.split('/')
      path.pop()
      path = path.join('/')

      await store.doUpdateHash(`/files${path}`)
    }
  } catch (error) {
    if (!error.code) {
      error.code = `ERR_${basename}`
    }

    console.error(error)
    dispatch({ type: `FILES_${basename}_FAILED`, payload: { id, error } })
  } finally {
    if (basename !== ACTIONS.FETCH) {
      await store.doFilesFetch()
    }
  }

  return data
}

const fileFromStats = ({ cumulativeSize, type, size, hash, name }, path) => ({
  size: cumulativeSize || size || null,
  type: (type === 'dir' || type === 'directory') ? 'directory' : 'file',
  hash: hash,
  name: name || path ? path.split('/').pop() : hash,
  path: path || `/ipfs/${hash}`
})

const pathToStat = async (path, ipfs) => {
  if (path.startsWith(MFS_PATH)) {
    return path.substr(MFS_PATH.length) || '/'
  } else if (path.startsWith('/ipns')) {
    return ipfs.name.resolve(path)
  }

  return path
}

const realMfsPath = (path) => {
  if (path.startsWith(MFS_PATH)) {
    return path.substr(MFS_PATH.length) || '/'
  }

  return path
}

const getRawPins = async (ipfs) => {
  const recursive = await ipfs.pin.ls({ type: 'recursive' })
  const direct = await ipfs.pin.ls({ type: 'direct' })

  return recursive.concat(direct)
}

const getPins = async (ipfs) => {
  const pins = await getRawPins(ipfs)

  const promises = pins
    .map(({ hash }) => ipfs.files.stat(`/ipfs/${hash}`))
  const stats = await Promise.all(promises)

  return stats.map(item => {
    item = fileFromStats(item)
    item.pinned = true
    return item
  })
}

const sortFiles = (files, sorting) => {
  const sortDir = sorting.asc ? 1 : -1
  const nameSort = sortByName(sortDir)
  const sizeSort = sortBySize(sortDir)

  return files.sort((a, b) => {
    if (a.type === b.type || isMac) {
      if (sorting.by === sorts.BY_NAME) {
        return nameSort(a.name, b.name)
      } else {
        return sizeSort(a.cumulativeSize || a.size, b.cumulativeSize || b.size)
      }
    }

    if (a.type === 'directory') {
      return -1
    } else {
      return 1
    }
  })
}

const fetchFiles = make(ACTIONS.FETCH, async (ipfs, id, { store }) => {
  const path = store.selectFilesPathFromHash()
  const toStat = await pathToStat(path, ipfs)

  if (path === '/ipns' || path === '/') {
    return {
      path: path,
      fetched: Date.now(),
      type: 'directory',
      content: []
    }
  }

  if (path === '/ipfs') {
    const pins = await getPins(ipfs)

    return {
      path: '/ipfs',
      fetched: Date.now(),
      type: 'directory',
      content: pins
    }
  }

  const stats = await ipfs.files.stat(toStat)

  if (stats.type === 'file') {
    return {
      ...fileFromStats(stats, path),
      fetched: Date.now(),
      type: 'file',
      read: () => ipfs.cat(stats.hash),
      name: path.split('/').pop(),
      size: stats.size,
      hash: stats.hash
    }
  }

  // Otherwise get the directory info
  const res = await ipfs.ls(stats.hash) || []
  const files = []
  const showStats = res.length < 100

  for (const f of res) {
    const absPath = join(path, f.name)
    let file = null

    if (showStats && f.type === 'dir') {
      file = fileFromStats(await ipfs.files.stat(`/ipfs/${f.hash}`), absPath)
    } else {
      file = fileFromStats(f, absPath)
    }

    files.push(file)
  }

  let upperPath = dirname(path)
  let upper = null

  if (upperPath !== '/ipns' && upperPath !== '/ipfs' && upperPath !== '/') {
    upper = fileFromStats(await ipfs.files.stat(await pathToStat(upperPath)))
  }

  if (upper) {
    upper.name = '...'
    upper.path = upperPath
    upper.isParent = true
  }

  return {
    path: path,
    fetched: Date.now(),
    type: 'directory',
    hash: stats.hash,
    upper: upper,
    content: sortFiles(files, store.selectFilesSorting())
  }
})

const defaultState = {
  pageContent: null,
  pins: [],
  sorting: { // TODO: cache this
    by: sorts.BY_NAME,
    asc: true
  },
  pending: [],
  finished: [],
  failed: []
}

export default (opts = {}) => {
  opts.baseUrl = opts.baseUrl || '/files'

  return {
    name: 'files',

    reducer: (state = defaultState, action) => {
      if (!action.type.startsWith('FILES_')) {
        return state
      }

      if (action.type === 'FILES_DISMISS_ERRORS') {
        return {
          ...state,
          failed: []
        }
      }

      if (action.type === 'FILES_UPDATE_SORT') {
        const pageContent = state.pageContent

        return {
          ...state,
          pageContent: {
            ...pageContent,
            content: sortFiles(pageContent.content, action.payload)
          },
          sorting: action.payload
        }
      }

      const [ type, status ] = action.type.split('_').splice(1)
      const { id, ...data } = action.payload

      if (status === 'STARTED') {
        return {
          ...state,
          pending: [
            ...state.pending,
            {
              type: type,
              id: id,
              start: Date.now(),
              data: data
            }
          ]
        }
      } else if (status === 'UPDATED') {
        const pendingAction = state.pending.find(a => a.id === id)

        return {
          ...state,
          pending: [
            ...state.pending.filter(a => a.id !== id),
            {
              ...pendingAction,
              data: data
            }
          ]
        }
      } else if (status === 'FAILED') {
        const pendingAction = state.pending.find(a => a.id === id)
        let additional

        if (type === ACTIONS.FETCH) {
          additional = {
            pageContent: null
          }
        }

        return {
          ...state,
          ...additional,
          pending: state.pending.filter(a => a.id !== id),
          failed: [
            ...state.failed,
            {
              ...pendingAction,
              end: Date.now(),
              error: data.error
            }
          ]
        }
      } else if (status === 'FINISHED') {
        const action = state.pending.find(a => a.id === id)
        let additional

        if (type === ACTIONS.FETCH) {
          additional = {
            pageContent: data
          }

          if (data.path === '/ipfs') {
            additional.pins = data.content.map(f => f.hash)
          }
        }

        return {
          ...state,
          ...additional,
          pending: state.pending.filter(a => a.id !== id),
          finished: [
            ...state.finished,
            {
              ...action,
              data: data,
              end: Date.now()
            }
          ]
        }
      }

      return state
    },

    doFilesFetch: () => async ({ store, ...args }) => {
      const isReady = store.selectIpfsReady()
      const isConnected = store.selectIpfsConnected()
      const isFetching = store.selectFilesIsFetching()
      const path = store.selectFilesPathFromHash()

      if (isReady && isConnected && !isFetching && path) {
        fetchFiles()({ store, ...args })
      }
    },

    doFilesWrite: make(ACTIONS.WRITE, async (ipfs, root, files, id, { dispatch }) => {
      files = files.filter(f => !ignore.includes(basename(f.path)))
      const totalSize = files.reduce((prev, { size }) => prev + size, 0)

      // Normalise all paths to be relative. Dropped files come as absolute,
      // those added by the file input come as relative paths, so normalise them.
      files.forEach(s => {
        if (s.path[0] === '/') {
          s.path = s.path.slice(1)
        }
      })

      const updateProgress = (sent) => {
        dispatch({ type: 'FILES_WRITE_UPDATED', payload: { id: id, progress: sent / totalSize * 100 } })
      }

      updateProgress(0)

      let res = null
      try {
        res = await ipfs.add(files, {
          pin: false,
          wrapWithDirectory: false,
          progress: updateProgress
        })
      } catch (error) {
        console.error(error)
        throw error
      }

      const numberOfFiles = files.length
      const numberOfDirs = countDirs(files)
      const expectedResponseCount = numberOfFiles + numberOfDirs

      if (res.length !== expectedResponseCount) {
        // See https://github.com/ipfs/js-ipfs-api/issues/797
        throw Object.assign(new Error(`API returned a partial response.`), { code: 'ERR_API_RESPONSE' })
      }

      for (const { path, hash } of res) {
        // Only go for direct children
        if (path.indexOf('/') === -1 && path !== '') {
          const src = `/ipfs/${hash}`
          const dst = join(root, path)

          try {
            await ipfs.files.cp([src, dst])
          } catch (err) {
            console.log(err, { root, path, src, dst })
            throw Object.assign(new Error(`Folder already exists.`), { code: 'ERR_FOLDER_EXISTS' })
          }
        }
      }

      updateProgress(totalSize)
    }),

    doFilesDelete: make(ACTIONS.DELETE, (ipfs, files) => {
      const promises = files.map(file => ipfs.files.rm(realMfsPath(file), { recursive: true }))
      return Promise.all(promises)
    }, { mfsOnly: true }),

    doFilesAddPath: make(ACTIONS.ADD_BY_PATH, (ipfs, root, src) => {
      src = realMfsPath(src)
      const name = src.split('/').pop()
      const dst = realMfsPath(join(root, name))
      const srcPath = src.startsWith('/') ? src : `/ipfs/${name}`

      return ipfs.files.cp([srcPath, dst])
    }, { mfsOnly: true }),

    doFilesDownloadLink: make(ACTIONS.DOWNLOAD_LINK, async (ipfs, files, id, { store }) => {
      const apiUrl = store.selectApiUrl()
      const gatewayUrl = store.selectGatewayUrl()
      return getDownloadLink(files, gatewayUrl, apiUrl, ipfs)
    }),

    doFilesShareLink: make(ACTIONS.SHARE_LINK, async (ipfs, files) => getShareableLink(files, ipfs)),

    doFilesMove: make(ACTIONS.MOVE, (ipfs, src, dst) => ipfs.files.mv([realMfsPath(src), realMfsPath(dst)]), { mfsOnly: true }),

    doFilesCopy: make(ACTIONS.COPY, (ipfs, src, dst) => ipfs.files.cp([realMfsPath(src), realMfsPath(dst)]), { mfsOnly: true }),

    doFilesMakeDir: make(ACTIONS.MAKE_DIR, (ipfs, path) => ipfs.files.mkdir(realMfsPath(path), { parents: true }), { mfsOnly: true }),

    doFilesDismissErrors: () => async ({ dispatch }) => dispatch({ type: 'FILES_DISMISS_ERRORS' }),

    doFilesNavigateTo: (path) => async ({ store }) => {
      const link = path.split('/').map(p => encodeURIComponent(p)).join('/')
      const files = store.selectFiles()

      if (files && files.path === link) {
        store.doFilesFetch()
      } else {
        store.doUpdateHash(`${opts.baseUrl}${link}`)
      }
    },

    doFilesUpdateSorting: (by, asc) => async ({ dispatch }) => {
      dispatch({ type: 'FILES_UPDATE_SORT', payload: { by, asc } })
    },

    selectFiles: (state) => state.files.pageContent,

    selectPins: (state) => state.files.pins,

    selectFilesIsFetching: (state) => state.files.pending.some(a => a.type === ACTIONS.FETCH),

    selectShowLoadingAnimation: (state) => {
      const pending = state.files.pending.find(a => a.type === ACTIONS.FETCH)
      return pending ? (Date.now() - pending.start) > 1000 : false
    },

    selectFilesSorting: (state) => state.files.sorting,

    selectWriteFilesProgress: (state) => {
      const writes = state.files.pending.filter(s => s.type === ACTIONS.WRITE && s.data.progress)

      if (writes.length === 0) {
        return null
      }

      const sum = writes.reduce((acc, s) => s.data.progress + acc, 0)
      return sum / writes.length
    },

    selectFilesHasError: (state) => state.files.failed.length > 0,

    selectFilesErrors: (state) => state.files.failed,

    selectFilesPathFromHash: createSelector(
      'selectRouteInfo',
      (routeInfo) => {
        if (!routeInfo.url.startsWith(opts.baseUrl)) return
        if (!routeInfo.params.path) return
        let path = routeInfo.params.path

        if (path.endsWith('/')) {
          path = path.substring(0, path.length - 1)
        }

        return decodeURIComponent(path)
      }
    ),

    selectFilesIsMfs: createSelector(
      'selectFilesPathFromHash',
      (path) => {
        return path ? path.startsWith(MFS_PATH) : false
      }
    )
  }
}
