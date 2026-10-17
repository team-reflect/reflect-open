import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import type { Unlisten } from '../unlisten.ts'
import type { AudioRecorderFinalSegment, AudioRecorderService } from './audio-recorder-service.ts'

/**
 * How long the recording UI must survive before a delivered native action is
 * confirmed (V1 parity): a webview crash during presentation must leave the
 * action queued so it re-fires on the next launch.
 */
const ACTION_CONFIRM_DELAY_MS = 2000

/**
 * The recording surface that answers the OS entry points.
 */
export interface NativeRecordActionHandler {
  /**
   * Start a memo, the surface's usual start (opens the drawer, records).
   */
  start(): Promise<void>
  /**
   * Receives the final segment of a recording that outlived its UI.
   */
  onReconciledSegment(segment: AudioRecorderFinalSegment): void
}

export interface NativeActionServiceDeps {
  readonly audioRecorder: AudioRecorderService
  readonly clock: ClockService
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

/**
 * The webview side of the native-action handshake (audio-memos wave 3), plus
 * the live-recording reconcile it must be sequenced behind.
 *
 * Reconcile first: a fresh surface did not start any recording, so a native
 * one still running (the webview reloaded or crashed mid-memo, or the surface
 * reopened across a graph switch) has no UI — stop and save it rather than
 * leave a hidden hot microphone.
 *
 * Then the handshake: OS entry points (Siri, the home-screen quick action,
 * the lock-screen widget) queue a `recordAudio` request in the plugin,
 * persisted until this surface confirms it ran — neither lost nor double-run
 * across webview churn (`docs/porting/reflect-mobile/native-entry-points.md`).
 * The ordering is the point: a queued "record" delivered at `actionsReady`
 * can never race the reconcile's stop.
 */
export interface NativeActionService {
  /**
   * Mount the reconcile-then-handshake lifecycle for `handler`; the returned
   * function ends it. Does nothing outside the native shell.
   */
  open(handler: NativeRecordActionHandler): Unlisten
}

class NativeActionServiceImpl implements NativeActionService {
  readonly #deps: NativeActionServiceDeps

  constructor(deps: NativeActionServiceDeps) {
    this.#deps = deps
  }

  open(handler: NativeRecordActionHandler): Unlisten {
    const { audioRecorder, clock, platform, logger } = this.#deps
    if (!platform.isNativeShell) {
      return () => {}
    }
    let disposed = false
    const stopped = new AbortController()
    let confirmTimer: TimerHandle | null = null
    let unlisten: Unlisten | null = null
    void (async () => {
      try {
        const status = await audioRecorder.status()
        if (status.recording) {
          const final = await audioRecorder.stop()
          if (final !== null) {
            handler.onReconciledSegment(final)
          }
        }
      } catch (cause) {
        // A user stop or native finalize winning the race lands here — the
        // memo arrives through that path (or the orphan scan) instead.
        logger.warn('reconciling a live native recording failed:', cause)
      }
      if (disposed) {
        return
      }
      unlisten = audioRecorder.subscribeNativeAction((event) => {
        if (event.action !== 'recordAudio') {
          return
        }
        void handler.start()
        // A repeat delivery (double widget open, or a redelivery while the
        // action is still queued) restarts the confirm window against the
        // latest start — otherwise an earlier timer could confirm before
        // this start's UI has survived its full window.
        if (confirmTimer !== null) {
          clock.clearTimeout(confirmTimer)
        }
        // Confirmation is about delivery, not success — a mic-denied start
        // still confirms, or the queue would re-surface the same failure
        // every launch.
        confirmTimer = clock.setTimeout(this.#confirmNativeAction, ACTION_CONFIRM_DELAY_MS)
      })
      try {
        await audioRecorder.actionsReady({ signal: stopped.signal })
      } catch (cause) {
        logger.error('the native-action handshake is unavailable:', cause)
      }
    })()
    return () => {
      disposed = true
      stopped.abort()
      if (confirmTimer !== null) {
        clock.clearTimeout(confirmTimer)
      }
      unlisten?.()
    }
  }

  readonly #confirmNativeAction = async (): Promise<void> => {
    const { audioRecorder, logger } = this.#deps
    try {
      await audioRecorder.actionPerformed()
    } catch (cause: unknown) {
      logger.warn('confirming a native action failed:', cause)
    }
  }
}

export function createNativeActionService(deps: NativeActionServiceDeps): NativeActionService {
  return new NativeActionServiceImpl(deps)
}
