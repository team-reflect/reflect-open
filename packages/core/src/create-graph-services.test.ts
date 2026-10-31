import { describe, expect, it, vi } from 'vitest'
import type { ICloudDownloadServiceOptions } from './sync/icloud-download-service.ts'
import type { ICloudSyncServiceOptions } from './sync/icloud-sync-service.ts'
import { trackAssetDescriptionSessions } from './testing/assets.ts'
import { createNodeTestDatabaseService } from './testing/database.ts'
import { createTestCoreServices, type TestCoreServices } from './testing/services.ts'
import {
  createTestGitSyncService,
  createTestICloudSyncService,
  type TestICloudSyncService,
} from './testing/sync.ts'
import type { GitSyncServiceOptions } from './sync/git-sync-service.ts'
import {
  createGraphServices,
  openGraphLifecycle,
  type GraphLifecycleFlags,
  type GraphServiceFactories,
  type GraphServicesDeps,
} from './create-graph-services.ts'
import { createGraphSession, type GraphRole } from './graph/graph-session.ts'

const ICLOUD_ROOT = '/Users/me/Library/Mobile Documents/iCloud~reflect/Documents/notes'

interface SetupOptions {
  role?: GraphRole
  root?: string
  indexGeneration?: number | null
  lifecycles?: Partial<GraphLifecycleFlags>
}

/**
 * Every lifecycle of a desktop main window, without the iCloud ones.
 */
const MAIN_LIFECYCLES: GraphLifecycleFlags = {
  gitSync: true,
  icloudSync: false,
  capture: true,
  assetDescription: true,
  icloudDownload: false,
  metadataWatch: false,
}

/**
 * Only the lifecycles every session runs.
 */
const NO_LIFECYCLES: GraphLifecycleFlags = {
  gitSync: false,
  icloudSync: false,
  capture: false,
  assetDescription: false,
  icloudDownload: false,
  metadataWatch: false,
}

/**
 * The deps of the per-session services, taken from the test core services.
 */
function sessionDeps(core: TestCoreServices) {
  const { icloudNative, fileChanges, indexLifecycle, activity, clock, logger } = core
  return {
    gitSync: {
      git: core.gitRepository,
      syncEngines: core.syncEngines,
      credentials: core.credentials,
      githubAuth: core.githubAuth,
      gitHostCredentials: core.gitHostCredentials,
      fileChanges,
      indexLifecycle,
      progress: core.progress,
      clock,
      activity,
      platform: core.platform,
      persistenceFlush: core.persistenceFlush,
      icloudNative,
      logger,
    },
    githubConnector: { githubAuth: core.githubAuth, githubRepos: core.githubRepos },
    gitHostConnector: { git: core.gitRepository, gitHostCredentials: core.gitHostCredentials },
    icloudSync: {
      icloudNative,
      fileChanges,
      indexLifecycle,
      openDocuments: core.openDocuments,
      activity,
      clock,
      logger,
      progress: core.progress,
    },
    icloudDownload: { icloudNative, activity, clock, logger },
  }
}

/**
 * One graph session's services over recording doubles.
 */
function setup(options?: SetupOptions) {
  const core = createTestCoreServices({ database: createNodeTestDatabaseService() })
  const assetSessions = trackAssetDescriptionSessions(core.assetDescription)
  const controller = new AbortController()
  const session = createGraphSession(
    {
      root: options?.root ?? '/g',
      name: 'g',
      generation: 3,
      indexGeneration: options?.indexGeneration === undefined ? 5 : options.indexGeneration,
      role: options?.role ?? 'main',
    },
    controller.signal,
  )
  const gitSync = createTestGitSyncService()
  const gitSyncOptionsLog: GitSyncServiceOptions[] = []
  const chats: { attached: number; detached: number }[] = []
  const icloudSyncs: { options: ICloudSyncServiceOptions; service: TestICloudSyncService }[] = []
  const downloads: { options: ICloudDownloadServiceOptions; calls: string[] }[] = []
  const createChat = core.chatSessions.create.bind(core.chatSessions)
  vi.spyOn(core.chatSessions, 'create').mockImplementation((chatOptions) => {
    const chat = createChat(chatOptions)
    const record = { attached: 0, detached: 0 }
    chats.push(record)
    vi.spyOn(chat, 'attach').mockImplementation(() => {
      record.attached += 1
      return () => {
        record.detached += 1
      }
    })
    return chat
  })
  const deps: GraphServicesDeps = {
    ...sessionDeps(core),
    capture: core.capture,
    assetDescription: core.assetDescription,
    chatSessions: core.chatSessions,
    attachments: core.attachments,
    graphSession: core.graphSession,
  }
  const factories: Partial<GraphServiceFactories> = {
    gitSync: (_deps, gitSyncOptions) => {
      gitSyncOptionsLog.push(gitSyncOptions)
      return gitSync
    },
    icloudSync: (_deps, syncOptions) => {
      const service = createTestICloudSyncService()
      icloudSyncs.push({ options: syncOptions, service })
      return service
    },
    icloudDownload: (_deps, downloadOptions) => {
      const calls: string[] = []
      downloads.push({ options: downloadOptions, calls })
      return {
        start: () => {
          calls.push('start')
        },
        dispose: () => {
          calls.push('dispose')
        },
      }
    },
  }
  const graph = createGraphServices(
    session,
    deps,
    { ...MAIN_LIFECYCLES, ...options?.lifecycles },
    factories,
  )
  return {
    core,
    assetSessions,
    controller,
    session,
    deps,
    factories,
    graph,
    gitSync,
    gitSyncOptionsLog,
    chats,
    icloudSyncs,
    downloads,
  }
}

describe('createGraphServices', () => {
  it('holds the session and its role', () => {
    const { session, graph } = setup({ role: 'note-window', lifecycles: NO_LIFECYCLES })
    expect(graph).toMatchObject({ session, role: 'note-window' })
  })

  it('starts every lifecycle it is given over the session generations', async () => {
    const context = setup()
    await context.core.settings.whenLoaded()

    expect(context.graph.gitSync).toBe(context.gitSync)
    expect(context.gitSyncOptionsLog).toEqual([{ root: '/g', generation: 3, indexGeneration: 5 }])
    expect(context.gitSync.calls()).toEqual([{ method: 'start' }])
    expect(context.chats).toEqual([{ attached: 1, detached: 0 }])
    expect(context.core.attachments.watchers()).toBe(1)
    expect(context.core.capture.sessions()).toEqual([
      { generation: 3, starts: 1, schedules: 0, disposed: false },
    ])
    expect(context.assetSessions()).toEqual([
      { generation: 3, indexGeneration: 5, starts: 1, schedules: 0, disposed: false },
    ])
    expect(context.icloudSyncs).toEqual([])
    expect(context.downloads).toEqual([])
  })

  it('runs every lifecycle of a graph whose index failed to open, until the session ends', () => {
    const context = setup({
      root: ICLOUD_ROOT,
      indexGeneration: null,
      lifecycles: { icloudSync: true },
    })

    expect(context.gitSyncOptionsLog).toEqual([
      {
        root: '/Users/me/Library/Mobile Documents/iCloud~reflect/Documents/notes',
        generation: 3,
        indexGeneration: null,
      },
    ])
    expect(context.icloudSyncs.map((sync) => sync.options.indexGeneration)).toEqual([null])
    expect(context.core.capture.sessions()).toHaveLength(1)
    expect(context.core.attachments.watchers()).toBe(1)
    expect(context.chats).toEqual([{ attached: 1, detached: 0 }])

    context.controller.abort()
    expect(context.gitSync.calls().at(-1)).toEqual({ method: 'dispose' })
    expect(context.icloudSyncs[0]?.service.calls()).toEqual(['start', 'dispose'])
    expect(context.core.capture.sessions()[0]?.disposed).toBe(true)
    expect(context.core.attachments.watchers()).toBe(0)
    expect(context.chats).toEqual([{ attached: 1, detached: 1 }])
  })

  it('runs only the chat session and the catalog watch without lifecycles', () => {
    const context = setup({ root: ICLOUD_ROOT, lifecycles: NO_LIFECYCLES })

    expect(context.graph.gitSync).toBeNull()
    expect(context.gitSyncOptionsLog).toEqual([])
    expect(context.chats).toEqual([{ attached: 1, detached: 0 }])
    expect(context.core.attachments.watchers()).toBe(1)
    expect(context.core.capture.sessions()).toEqual([])
    expect(context.assetSessions()).toEqual([])
    expect(context.icloudSyncs).toEqual([])
    expect(context.downloads).toEqual([])
  })

  it('disposes every lifecycle when the session ends', () => {
    const context = setup({
      root: ICLOUD_ROOT,
      lifecycles: { icloudSync: true, icloudDownload: true },
    })
    context.controller.abort()

    expect(context.gitSync.calls().at(-1)).toEqual({ method: 'dispose' })
    expect(context.chats).toEqual([{ attached: 1, detached: 1 }])
    expect(context.core.attachments.watchers()).toBe(0)
    expect(context.core.capture.sessions()[0]?.disposed).toBe(true)
    expect(context.assetSessions()[0]?.disposed).toBe(true)
    expect(context.icloudSyncs[0]?.service.calls()).toEqual(['start', 'dispose'])
    expect(context.downloads[0]?.calls).toEqual(['start', 'dispose'])
  })

  it('passes the metadata watch to the iCloud conflict lifecycle', () => {
    const desktop = setup({ root: ICLOUD_ROOT, lifecycles: { icloudSync: true } })
    expect(desktop.icloudSyncs.map((sync) => sync.options)).toEqual([
      { root: ICLOUD_ROOT, generation: 3, indexGeneration: 5, metadataWatch: false },
    ])

    const mobile = setup({
      root: ICLOUD_ROOT,
      lifecycles: { icloudSync: true, metadataWatch: true },
    })
    expect(mobile.icloudSyncs.map((sync) => sync.options.metadataWatch)).toEqual([true])
  })

  it('refreshes downloads of the session root and refreshes the index after them', () => {
    const context = setup({ root: ICLOUD_ROOT, lifecycles: { icloudDownload: true } })
    expect(context.downloads.map((download) => download.options.root)).toEqual([ICLOUD_ROOT])
    const refreshIndex = vi.spyOn(context.core.graphSession, 'refreshIndex')
    context.downloads[0]?.options.refreshIndex()
    expect(refreshIndex).toHaveBeenCalledTimes(1)
    expect(context.downloads[0]?.calls).toEqual(['start'])
  })

  it('leaves nothing running for a session that already ended', () => {
    const core = createTestCoreServices({ database: createNodeTestDatabaseService() })
    const controller = new AbortController()
    controller.abort()
    const session = createGraphSession(
      { root: '/g', name: 'g', generation: 3, indexGeneration: 5 },
      controller.signal,
    )
    const gitSync = createTestGitSyncService()
    createGraphServices(
      session,
      {
        ...sessionDeps(core),
        capture: core.capture,
        assetDescription: core.assetDescription,
        chatSessions: core.chatSessions,
        attachments: core.attachments,
        graphSession: core.graphSession,
      },
      MAIN_LIFECYCLES,
      { gitSync: () => gitSync },
    )

    expect(gitSync.calls()).toEqual([{ method: 'start' }, { method: 'dispose' }])
    expect(core.attachments.watchers()).toBe(0)
    expect(core.capture.sessions()[0]?.disposed).toBe(true)
  })
})

describe('openGraphLifecycle', () => {
  it('opens one lifecycle of the session until its teardown', () => {
    const context = setup({ lifecycles: NO_LIFECYCLES })
    const close = openGraphLifecycle(
      context.session,
      context.deps,
      'assetDescription',
      context.factories,
    )
    expect(context.assetSessions().map((session) => session.disposed)).toEqual([false])
    close()
    expect(context.assetSessions().map((session) => session.disposed)).toEqual([true])

    const stop = openGraphLifecycle(
      context.session,
      context.deps,
      'icloudDownload',
      context.factories,
    )
    stop()
    expect(context.downloads[0]?.calls).toEqual(['start', 'dispose'])
  })
})
