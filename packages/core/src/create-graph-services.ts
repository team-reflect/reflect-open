import type { ChatSession, ChatSessionService } from './ai/chat/chat-session-service.ts'
import type { AssetDescriptionService } from './assets/asset-description-service.ts'
import type { CaptureService } from './capture/capture-service.ts'
import type { AttachmentService } from './documents/attachment-service.ts'
import type { GraphSessionService } from './graph/graph-session-service.ts'
import {
  createGitSyncService,
  type GitSyncService,
  type GitSyncServiceDeps,
} from './sync/git-sync-service.ts'
import {
  createICloudDownloadService,
  type ICloudDownloadServiceDeps,
} from './sync/icloud-download-service.ts'
import { createICloudSyncService, type ICloudSyncServiceDeps } from './sync/icloud-sync-service.ts'
import type { GraphRole, GraphSession } from './graph/graph-session.ts'

/**
 * What {@link createGraphServices} builds the lifecycles of one graph session from.
 */
export interface GraphServicesDeps {
  /**
   * The deps of the git sync service.
   */
  readonly gitSync: GitSyncServiceDeps
  /**
   * The deps of the iCloud conflict service.
   */
  readonly icloudSync: ICloudSyncServiceDeps
  /**
   * The deps of the iCloud download service.
   */
  readonly icloudDownload: ICloudDownloadServiceDeps
  /**
   * Opens the capture drain session.
   */
  readonly capture: CaptureService
  /**
   * Opens the asset description session.
   */
  readonly assetDescription: AssetDescriptionService
  /**
   * Creates the chat session of every session.
   */
  readonly chatSessions: ChatSessionService
  /**
   * Watches the attachment catalog of every session.
   */
  readonly attachments: AttachmentService
  /**
   * Gives the iCloud download service the index refresh it calls after downloads land.
   */
  readonly graphSession: GraphSessionService
}

/**
 * Which lifecycles {@link createGraphServices} runs for one session, each for the whole session.
 */
export interface GraphLifecycleFlags {
  /**
   * The Git sync service.
   */
  readonly gitSync: boolean
  /**
   * The iCloud conflict sweeps.
   */
  readonly icloudSync: boolean
  /**
   * The capture drain.
   */
  readonly capture: boolean
  /**
   * The asset descriptions.
   */
  readonly assetDescription: boolean
  /**
   * The iCloud download refresh.
   */
  readonly icloudDownload: boolean
  /**
   * The iCloud conflict sweeps also watch the file metadata.
   */
  readonly metadataWatch: boolean
}

/**
 * A lifecycle that {@link openGraphLifecycle} opens on its own.
 */
export type GraphLifecycle = 'assetDescription' | 'icloudDownload'

/**
 * The factory of each per-session service that {@link createGraphServices} builds.
 */
export const graphServiceFactories = {
  gitSync: createGitSyncService,
  icloudSync: createICloudSyncService,
  icloudDownload: createICloudDownloadService,
}

/**
 * The factory of each per-session service; a replacement gets the same deps and options.
 */
export type GraphServiceFactories = typeof graphServiceFactories

/**
 * The graph-scoped services: one set per {@link GraphSession}, disposed when
 * its `signal` aborts. A graph whose index failed to open has a session too,
 * and its lifecycles run with a null `indexGeneration`.
 *
 * Every session runs the chat session and the attachment catalog watch; the
 * {@link GraphLifecycleFlags} pick the other lifecycles. `gitSync` is `null`
 * when git sync does not run. The lifecycles that no surface reads run
 * inside and have no field.
 */
export interface GraphServices {
  /**
   * The graph session these services run for.
   */
  readonly session: GraphSession
  /**
   * The role of this window for the session.
   */
  readonly role: GraphRole
  /**
   * The chat session of this graph.
   */
  readonly chat: ChatSession
  /**
   * The git sync lifecycle; `null` when it does not run.
   */
  readonly gitSync: GitSyncService | null
}

/**
 * Open one lifecycle of `session`; the returned function disposes it.
 */
export function openGraphLifecycle(
  session: GraphSession,
  deps: GraphServicesDeps,
  lifecycle: GraphLifecycle,
  factories?: Partial<GraphServiceFactories>,
): () => void {
  const { root, generation, indexGeneration } = session
  if (lifecycle === 'assetDescription') {
    const describe = deps.assetDescription.openSession({ generation, indexGeneration })
    describe.start()
    return () => {
      describe.dispose()
    }
  }
  const create = { ...graphServiceFactories, ...factories }
  const downloads = create.icloudDownload(deps.icloudDownload, {
    root,
    refreshIndex: () => deps.graphSession.refreshIndex(),
  })
  downloads.start()
  return () => {
    downloads.dispose()
  }
}

export function createGraphServices(
  session: GraphSession,
  deps: GraphServicesDeps,
  lifecycles: GraphLifecycleFlags,
  factories?: Partial<GraphServiceFactories>,
): GraphServices {
  const { root, generation, indexGeneration, signal } = session
  const create = { ...graphServiceFactories, ...factories }
  const { capture, chatSessions, attachments } = deps
  const disposers: Array<() => void> = []

  const dispose = (): void => {
    for (const teardown of disposers.splice(0).reverse()) {
      teardown()
    }
  }
  let chat: GraphServices['chat']
  let gitSync: GitSyncService | null = null
  try {
    chat = chatSessions.create({ session })
    disposers.push(chat.attach())
    disposers.push(attachments.watchCatalog(generation))

    if (lifecycles.gitSync) {
      const sessionGitSync = create.gitSync(deps.gitSync, { root, generation, indexGeneration })
      gitSync = sessionGitSync
      void sessionGitSync.start()
      disposers.push(() => {
        sessionGitSync.dispose()
      })
    }
    if (lifecycles.icloudSync) {
      const icloud = create.icloudSync(deps.icloudSync, {
        root,
        generation,
        indexGeneration,
        metadataWatch: lifecycles.metadataWatch,
      })
      void icloud.start()
      disposers.push(() => {
        icloud.dispose()
      })
    }
    if (lifecycles.capture) {
      const captureSession = capture.openSession({ generation })
      captureSession.start()
      disposers.push(() => {
        captureSession.dispose()
      })
    }
    if (lifecycles.assetDescription) {
      disposers.push(openGraphLifecycle(session, deps, 'assetDescription', factories))
    }
    if (lifecycles.icloudDownload) {
      disposers.push(openGraphLifecycle(session, deps, 'icloudDownload', factories))
    }
  } catch (cause) {
    dispose()
    throw cause
  }
  if (signal.aborted) {
    dispose()
  } else {
    signal.addEventListener('abort', dispose, { once: true })
  }

  return { session, role: session.role, chat, gitSync }
}
