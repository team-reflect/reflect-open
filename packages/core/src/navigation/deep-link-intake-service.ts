import type { MaybePromise } from '@reflect/utils'
import { textCaptureEnvelopeSchema } from '../capture/capture-envelope.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { GraphSession, GraphSessionSource } from '../graph/graph-session.ts'
import type { IdService } from '../ports/id-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { errorMessage } from '../errors.ts'
import type { CaptureInboxService } from '../graph/capture-inbox-service.ts'
import type { IndexQueryService } from '../indexing/index-query-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { DeepLinkPlace } from './deep-link.ts'
import { parseDeepLink } from './deep-link-parse.ts'

/**

 * The operating system's delivery of `reflect://` URLs to the app.

 */
export interface DeepLinkSource {
  /**
   * Hear the URLs that arrive while the app runs.
   */
  onOpenUrl(listener: (urls: string[]) => void): MaybePromise<Unlisten>
  /**
   * The URLs the app was launched with, or `null`.
   */
  getCurrent(): MaybePromise<string[] | null>
}

/**

 * A {@link DeepLinkSource} for hosts where the system delivers no URLs.

 */
export function createNoDeepLinkSource(): DeepLinkSource {
  return {
    onOpenUrl: () => Promise.resolve(() => {}),
    getCurrent: () => Promise.resolve(null),
  }
}

/**
 * What one `reflect://` URL resolved to. `note` carries the resolved path,
 * `capture` means the capture was spooled, and `none` means there is nothing
 * to act on: the URL was rejected, a step failed, or the link went stale.
 * Every failure is already on the operations status line.
 */
export type DeepLinkTarget =
  | DeepLinkPlace
  | { kind: 'note'; path: string }
  | { kind: 'capture' }
  | { kind: 'none' }

export interface DeepLinkResolveOptions {
  /**
   * Whether the graph session or navigation intent changed while the
   * resolution awaited. Note resolution queries whichever index is open when
   * it runs, so a stale result must be dropped, never navigated — it may name
   * a homonym note in the newly opened graph or override a newer user action.
   * (The capture path needs no gate: the spool write is generation-pinned in
   * Rust and fails loudly when stale.)
   */
  readonly isStale?: () => boolean
  /**
   * The graph a capture spools into; defaults to the graph open when the call starts.
   */
  readonly session?: GraphSession | null
}

/**
 * The app-lifetime deep-link intake. The OS delivers `reflect://` URLs to the
 * app as a whole, but they can only be *acted on* inside an open graph, so
 * the service decouples the two lifetimes:
 * {@link DeepLinkIntakeService.startListener} subscribes exactly once per app
 * run, and URLs buffer until a listener subscribes — a link that launched the
 * app, or arrived on the graph chooser, fires the moment the graph opens
 * instead of being dropped.
 */
export interface DeepLinkIntakeService {
  /**
   * Subscribe to the {@link DeepLinkSource} once for the app's lifetime: the
   * URL stream (`onOpenUrl`) for URLs that arrive while running, then
   * `getCurrent` for the URL the app was launched with — `onOpenUrl` alone
   * does not replay it. Subscribing before the `getCurrent` read means a URL
   * landing in the startup gap is doubled rather than dropped; doubling is
   * benign (navigation is idempotent, and the capture drain's exact-line
   * dedupe absorbs a repeated append). Idempotent: the subscription is never
   * torn down, so a re-render or StrictMode double-mount can't re-deliver the
   * launch URL.
   */
  startListener(): Promise<void>
  /**
   * Feed one `reflect://` URL into the intake as if the OS had delivered it —
   * the entry point for deep links clicked *inside* the app (a link in a note
   * body must not round-trip through the OS opener: the opener capability
   * denies the scheme, dev builds don't register it, and macOS could hand the
   * URL to a different installed flavor). Buffers like any OS delivery when no
   * listener is subscribed.
   */
  dispatch(url: string): void
  /**
   * Hear every incoming URL until the returned function is called. The first
   * listener drains the URLs that arrived while none was subscribed, in
   * arrival order.
   */
  onUrl(listener: (url: string) => void): Unlisten
  /**
   * Resolve one incoming `reflect://` URL: a place link answers its place, a
   * note target resolves through the index, and a capture link spools an
   * envelope into `.reflect/inbox/` for the watcher-triggered drain to
   * materialize. Every outcome that isn't a place or a note surfaces on the
   * operations status line — an outside-world input must never crash or
   * silently vanish.
   */
  resolve(url: string, options?: DeepLinkResolveOptions): Promise<DeepLinkTarget>
}

export interface DeepLinkIntakeServiceDeps {
  readonly source: DeepLinkSource
  readonly indexQuery: IndexQueryService
  readonly captureInbox: CaptureInboxService
  readonly progress: ProgressPort
  readonly id: IdService
  readonly clock: ClockService
  readonly graphSession: GraphSessionSource
}

const NONE: DeepLinkTarget = { kind: 'none' }

class DeepLinkIntakeServiceImpl implements DeepLinkIntakeService {
  readonly #deps: DeepLinkIntakeServiceDeps
  #pendingUrls: string[] = []
  readonly #listeners = new Set<(url: string) => void>()
  #started = false

  constructor(deps: DeepLinkIntakeServiceDeps) {
    this.#deps = deps
  }

  async startListener(): Promise<void> {
    if (this.#started) {
      return
    }
    this.#started = true
    let unlisten: Unlisten | null = null
    try {
      unlisten = await this.#deps.source.onOpenUrl((urls) => {
        for (const url of urls) {
          this.dispatch(url)
        }
      })
      for (const url of (await this.#deps.source.getCurrent()) ?? []) {
        this.dispatch(url)
      }
    } catch (cause) {
      // Unlatch FIRST so a later call can retry — a failed start must not
      // disable deep links for the rest of the app run. If the subscription
      // itself succeeded (`getCurrent` failed), tear it down too, or the retry
      // would stack a second subscription and double-deliver every URL; the
      // teardown is best-effort, so a throwing unlisten can neither re-latch
      // nor mask the original failure.
      this.#started = false
      try {
        unlisten?.()
      } catch {
        // the original `cause` is the story
      }
      throw cause
    }
  }

  dispatch(url: string): void {
    if (this.#listeners.size === 0) {
      this.#pendingUrls.push(url)
      return
    }
    for (const listener of this.#listeners) {
      listener(url)
    }
  }

  onUrl(listener: (url: string) => void): Unlisten {
    const first = this.#listeners.size === 0
    this.#listeners.add(listener)
    if (first && this.#pendingUrls.length > 0) {
      const queued = this.#pendingUrls
      this.#pendingUrls = []
      for (const url of queued) {
        listener(url)
      }
    }
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async resolve(url: string, options?: DeepLinkResolveOptions): Promise<DeepLinkTarget> {
    const { indexQuery, captureInbox, progress, id, clock, graphSession } = this.#deps
    const isStale = options?.isStale
    const session =
      options?.session === undefined ? graphSession.getState().session : options.session
    const link = parseDeepLink(url)
    if (link === null) {
      progress.fail('Opening link', `Unrecognized link: ${truncate(url)}`)
      return NONE
    }
    switch (link.kind) {
      case 'navigate':
        return link.place
      case 'openNote': {
        let path: string | null
        try {
          path = await indexQuery.resolveNoteTarget(link.target)
        } catch (cause) {
          if (isStale?.() === true) {
            return NONE
          }
          progress.fail('Opening link', errorMessage(cause))
          return NONE
        }
        if (isStale?.() === true) {
          return NONE // the graph switched mid-resolve; the result answers the wrong graph
        }
        if (path === null) {
          progress.fail('Opening link', `Note not found: ${truncate(link.target)}`)
          return NONE
        }
        return { kind: 'note', path }
      }
      case 'capture': {
        const label =
          link.capture === 'task'
            ? 'Task added to today'
            : link.capture === 'checkbox'
              ? 'Checkbox added to today'
              : 'Added to today'
        if (session === null) {
          progress.fail('Saving capture', 'No graph is open.')
          return NONE
        }
        try {
          // The URL parser enforces the same text constraints, so this parse is
          // belt-and-braces — but it is fallible, and a schema tightening must
          // surface like every other failure here, not escape the handler.
          const envelope = textCaptureEnvelopeSchema.parse({
            version: 1,
            id: id.uuid(),
            kind: link.capture,
            text: link.text,
            capturedAt: new Date(clock.now()).toISOString(),
            source: 'deep-link',
          })
          await captureInbox.spool(
            `${envelope.id}.json`,
            JSON.stringify(envelope),
            session.generation,
          )
        } catch (cause) {
          progress.fail('Saving capture', errorMessage(cause))
          return NONE
        }
        progress.start(label).done()
        return { kind: 'capture' }
      }
    }
  }
}

export function createDeepLinkIntakeService(
  deps: DeepLinkIntakeServiceDeps,
): DeepLinkIntakeService {
  return new DeepLinkIntakeServiceImpl(deps)
}

/**

 * Status-line-sized excerpt of an untrusted URL or target.

 */
function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}…` : value
}
