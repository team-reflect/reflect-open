import type { MaybePromise } from '@reflect/utils'
import { appendXPost } from './bookmark-capture.ts'
import type { XPostEnvelope } from './bookmark-envelope.ts'
import { isCaptureSpoolPath } from './capture-identity.ts'
import {
  createCaptureLinkRepairService,
  type CaptureLinkRepairService,
} from './capture-link-repair-service.ts'
import type { AiCredentialService } from '../ai/ai-credential-service.ts'
import type { AiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { PageDescriberService } from '../ai/page-describer-service.ts'
import type { BackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { isMobilePlatform } from '../ports/platform-facts.ts'
import { isSilentStop, type ReconcileStop } from '../reconcile/reconcile.ts'
import type { WebFetchService } from '../link-preview/web-fetch-service.ts'
import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { CaptureInboxService } from '../graph/capture-inbox-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { PrivacyService } from '../privacy/privacy-service.ts'
import type { XArchiveService } from '../embeds/x-archive-service.ts'
import type { BacklinkTargetService } from './backlink-target-service.ts'
import { createCaptureDrainService, type CaptureDrainService } from './capture-drain-service.ts'
import {
  createCaptureEnrichmentService,
  type CaptureEnrichmentService,
} from './capture-enrichment-service.ts'
import { createPageMetaService } from './page-meta-service.ts'

/**
 * The link-capture lifecycle for one graph session. Built on
 * `BackgroundReconcilerFactory` (shared with transcription and asset
 * descriptions): the single-flight loop, focus/online retries, and teardown live
 * there; this supplies the capture-specific pass and triggers.
 *
 * Every pass runs the two capture phases in order: **drain** the spool inbox
 * (the durable raw save — works without any AI configured), then **enrich**
 * pending captures (meta scrape + BYOK description). The launch pass is the
 * headline behavior: captures spooled while the app was closed land the
 * moment a graph opens. Each pass then repairs placeholder link text that
 * sync brought back into the Daily notes of recent captures.
 */
export interface CaptureSession {
  /**
   * Register the native-messaging host (desktop), then attach the triggers
   * (watcher, focus, online) and run the launch pass.
   */
  start(): void
  /**
   * Request a pass; coalesces while one runs (at most one follow-up).
   */
  schedule(): void
  /**
   * Tear down triggers and abort an in-flight pass at its next gate.
   */
  dispose(): void
}

export interface CaptureSessionOptions {
  /**
   * The open graph's generation. Every pass's reads and writes pin to it.
   */
  generation: number
}

export interface CaptureServiceDeps {
  readonly captureInbox: CaptureInboxService
  readonly noteFile: NoteFileService
  readonly assetStore: AssetStoreService
  readonly openDocuments: OpenDocumentsService
  readonly backlinkTarget: BacklinkTargetService
  readonly xArchive: XArchiveService
  readonly webFetch: WebFetchService
  readonly pageDescriber: PageDescriberService
  readonly aiProviderConfig: AiProviderConfigService
  readonly aiCredentials: AiCredentialService
  readonly privacy: PrivacyService
  readonly clock: ClockService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly activity: ActivityPort
  readonly fileChanges: FileChangeService
  readonly progress: ProgressPort
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

/**
 * Link capture (Plan 11): lands the captures spooled by the browser
 * extension, the iOS share extension, Shortcuts and deep links in the daily
 * note, then enriches them. Capture has no in-app surface; the daily note is
 * the output.
 *
 * On desktop every session first registers the native-messaging host (pointer
 * file + browser manifests, rewritten on every graph open so app moves
 * self-heal). On the mobile surface there is no native-messaging host to
 * register; instead every pass first relays the App Group inbox the iOS share
 * extension spools into, and the session re-runs on app resume.
 */
export interface CaptureService {
  /**
   * Build the lifecycle for one graph session. `dispose()` is terminal.
   */
  openSession(options: CaptureSessionOptions): CaptureSession
  /**
   * Fires after a pass may have written X post archives, even when it stopped partway.
   */
  onXPostsWritten(listener: () => void): Unlisten
}

interface CaptureSessionDeps {
  readonly captureInbox: CaptureInboxService
  readonly drain: CaptureDrainService
  readonly enrichment: CaptureEnrichmentService
  readonly linkRepair: CaptureLinkRepairService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly activity: ActivityPort
  readonly fileChanges: FileChangeService
  readonly progress: ProgressPort
  readonly platform: PlatformFacts
  readonly logger: LoggerService
  readonly commitXPost: (
    envelope: XPostEnvelope,
    path: string,
    generation: number,
  ) => MaybePromise<void>
  readonly notifyXPostsWritten: () => void
}

class CaptureSessionImpl implements CaptureSession {
  readonly #deps: CaptureSessionDeps
  readonly #generation: number
  // The mobile shell has no file watcher, so returning to the app is the
  // arrival signal for captures shared while it was backgrounded.
  readonly #mobile: boolean
  /**
   * Last surfaced stop message per phase label. Retries must not re-toast
   * it. Keyed by label so one phase succeeding (which clears its own entry)
   * cannot make another phase's persistent failure re-toast every pass.
   */
  readonly #surfacedStops = new Map<string, string>()
  readonly #loop: ReturnType<BackgroundReconcilerFactory['create']>

  constructor(deps: CaptureSessionDeps, options: CaptureSessionOptions) {
    this.#deps = deps
    this.#generation = options.generation
    this.#mobile = isMobilePlatform(deps.platform.appPlatform) || deps.platform.surface.mobileApp
    this.#loop = deps.reconcilers.create({ pass: (isStale) => this.#reconcile(isStale) })
  }

  start(): void {
    const { captureInbox, logger } = this.#deps
    // Registration (the pointer-file rewrite) completes BEFORE the first
    // drain: on a graph switch this repoints the host at the new graph as
    // early as possible, instead of draining here while the pointer still
    // names the old one. (The host reads the pointer per capture in its own
    // process, so a capture racing the rewrite can still spool to the
    // previous graph's inbox, it drains when that graph next opens.)
    // Best-effort: a failed registration must not block the drain. Captures
    // already spooled must land regardless, and the extension surfaces
    // "host not found" with install guidance on its side. Mobile has no host
    // process at all: the share extension finds the App Group inbox itself.
    const registered = this.#mobile
      ? Promise.resolve()
      : captureInbox.registerHost().catch((cause: unknown) => {
          logger.error('capture host registration failed:', cause)
        })
    void registered.then(() => {
      this.#launch() // a no-op if the session was disposed while registering
    })
  }

  schedule(): void {
    this.#loop.schedule()
  }

  dispose(): void {
    this.#loop.dispose()
  }

  #launch(): void {
    const { activity, fileChanges } = this.#deps
    const loop = this.#loop
    if (loop.isStale()) {
      return
    }
    loop.schedule() // the launch pass: captures spooled while the app was closed
    loop.retryOnWake() // the network's natural retry signals (enrichment)
    if (this.#mobile) {
      // Mobile resume: `focus` alone is unreliable in the iOS webview (the
      // iCloud refresh hook listens to both for the same reason).
      loop.onDispose(
        activity.subscribeVisible(() => {
          loop.schedule()
        }),
      )
    }
    loop.onDispose(
      fileChanges.subscribe(({ changes }) => {
        const hasNewCapture = changes.some(
          (change) => change.kind === 'upsert' && isCaptureSpoolPath(change.path),
        )
        if (hasNewCapture) {
          loop.schedule()
        }
      }),
    )
  }

  #surfaceStop(label: string, stopped: ReconcileStop | null): void {
    if (stopped === null) {
      this.#surfacedStops.delete(label)
      return
    }
    // Self-healing stops (network/config/stale) stay silent: offline retries on
    // the next trigger, config means no provider/key (enrichment waits; the raw
    // save is done), stale is a graph switch tearing the pass down.
    if (isSilentStop(stopped) || this.#surfacedStops.get(label) === stopped.message) {
      return
    }
    this.#surfacedStops.set(label, stopped.message)
    this.#deps.progress.fail(label, stopped.message)
  }

  /**
   * One pass: drain the spool inbox (no AI needed), enrich pending captures,
   * then repair placeholder capture links.
   */
  async #reconcile(isStale: () => boolean): Promise<void> {
    const { captureInbox, drain, enrichment, linkRepair, commitXPost, notifyXPostsWritten } =
      this.#deps
    const generation = this.#generation
    if (this.#mobile) {
      let relayStop: ReconcileStop | null = null
      try {
        // Move envelopes the iOS share extension spooled into the App Group
        // inbox into the graph's capture inbox, ahead of every drain.
        await captureInbox.relaySharedInbox(generation)
      } catch (cause) {
        // Already-relayed envelopes must still drain, so a relay failure
        // surfaces like a drain stop instead of aborting the pass.
        relayStop = { reason: toAppError(cause).kind, message: errorMessage(cause) }
      }
      this.#surfaceStop('Saving shared capture', relayStop)
      if (isStale()) {
        return
      }
    }
    const drained = await drain.drain({
      generation,
      isStale,
      writeXPost: (envelope, path) => commitXPost(envelope, path, generation),
    })
    // A bookmark pass may have written X post archives, even when it stopped partway.
    if (drained.drained > 0 || drained.stopped !== null) {
      notifyXPostsWritten()
    }
    this.#surfaceStop('Saving link capture', drained.stopped)
    if (isStale()) {
      return
    }
    // The provider entry and its key are read at the start of every
    // enrichment pass. A key added in Settings mid-session must be seen by
    // the very next pass.
    const enriched = await enrichment.reconcile({ generation, isStale })
    this.#surfaceStop('Enriching link capture', enriched.stopped)
    if (isStale()) {
      return
    }
    await linkRepair.sweep(generation)
  }
}

class CaptureServiceImpl implements CaptureService {
  readonly #deps: CaptureServiceDeps
  readonly #drain: CaptureDrainService
  readonly #enrichment: CaptureEnrichmentService
  readonly #linkRepair: CaptureLinkRepairService
  readonly #xPostListeners = new Set<() => void>()

  constructor(deps: CaptureServiceDeps) {
    const { captureInbox, noteFile, assetStore, xArchive, backlinkTarget, webFetch } = deps
    this.#deps = deps
    this.#drain = createCaptureDrainService({
      captureInbox,
      noteFile,
      xArchive,
      backlinkTarget,
      clock: deps.clock,
      logger: deps.logger,
    })
    this.#enrichment = createCaptureEnrichmentService({
      noteFile,
      assetStore,
      webFetch,
      pageMeta: createPageMetaService({ webFetch }),
      pageDescriber: deps.pageDescriber,
      aiProviderConfig: deps.aiProviderConfig,
      aiCredentials: deps.aiCredentials,
      privacy: deps.privacy,
    })
    this.#linkRepair = createCaptureLinkRepairService({
      noteFile,
      openDocuments: deps.openDocuments,
      clock: deps.clock,
      logger: deps.logger,
    })
  }

  openSession(options: CaptureSessionOptions): CaptureSession {
    const { captureInbox, reconcilers, activity, fileChanges, progress, platform, logger } =
      this.#deps
    return new CaptureSessionImpl(
      {
        captureInbox,
        drain: this.#drain,
        enrichment: this.#enrichment,
        linkRepair: this.#linkRepair,
        reconcilers,
        activity,
        fileChanges,
        progress,
        platform,
        logger,
        commitXPost: (envelope, path, generation) => this.#commitXPost(envelope, path, generation),
        notifyXPostsWritten: () => {
          for (const listener of this.#xPostListeners) {
            listener()
          }
        },
      },
      options,
    )
  }

  onXPostsWritten(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#xPostListeners.add(deliver)
    return () => {
      this.#xPostListeners.delete(deliver)
    }
  }

  /**
   * Route an X post through the live daily document, or a revision-checked file write.
   */
  async #commitXPost(envelope: XPostEnvelope, path: string, generation: number): Promise<void> {
    const { openDocuments, noteFile } = this.#deps
    const owner = openDocuments.sessionFor(path)
    if (owner !== null) {
      if (!(await owner.commitSourceEdit((source) => appendXPost(source, envelope)))) {
        throw new Error('Resolve or finish loading the daily note before saving X posts')
      }
      return
    }
    let source: string | null
    try {
      source = await noteFile.read(path, generation)
    } catch (cause) {
      if (!isAppError(cause) || cause.kind !== 'notFound') throw cause
      source = null
    }
    // A document may have opened while the filesystem read was pending.
    const opened = openDocuments.sessionFor(path)
    if (opened !== null) {
      if (!(await opened.commitSourceEdit((current) => appendXPost(current, envelope)))) {
        throw new Error('The daily note is busy; X post remains queued')
      }
      return
    }
    const next = appendXPost(source ?? '', envelope)
    if (next !== source) await noteFile.write(path, next, generation, source)
  }
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  return new CaptureServiceImpl(deps)
}
