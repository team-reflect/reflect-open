import { useEffect, useRef } from 'react'
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { hasBridge } from '@reflect/core'
import { z } from 'zod'
import { nativeRecordingStatus, stopActiveRecording } from '@/mobile/use-native-audio-recorder'
import type { StagedRecordingInput } from '@/mobile/use-staged-recording-ingest'

/**
 * The webview side of the native-action handshake (audio-memos wave 3), plus
 * the live-recording reconcile it must be sequenced behind.
 *
 * Reconcile first: this mount did not start any recording, so a native one
 * still running (the webview reloaded or crashed mid-memo, or the provider
 * remounted across a graph switch) has no UI — stop and save it rather than
 * leave a hidden hot microphone.
 *
 * Then the handshake: OS entry points (Siri, the home-screen quick action,
 * the lock-screen widget) queue a `recordAudio` request in the plugin,
 * persisted until this surface confirms it ran — neither lost nor double-run
 * across webview churn (`docs/porting/reflect-mobile/native-entry-points.md`).
 * The ordering is the point of the single effect: a queued "record"
 * delivered at `actions_ready` can never race the reconcile's stop.
 */

const nativeActionSchema = z.object({ action: z.string() })

/**
 * How long the recording UI must survive before a delivered native action is
 * confirmed (V1 parity): a webview crash during presentation must leave the
 * action queued so it re-fires on the next launch.
 */
const ACTION_CONFIRM_DELAY_MS = 2000

export interface UseNativeRecordActionOptions {
  /** Start a memo — the provider's usual start (opens the drawer, records). */
  start: () => Promise<void>
  /** Hand a reconciled recording to the capture pipeline. */
  enqueueStaged: (input: StagedRecordingInput) => void
}

/** Mount the reconcile-then-handshake lifecycle. */
export function useNativeRecordAction(options: UseNativeRecordActionOptions): void {
  const { enqueueStaged } = options
  // Read at fire time — the provider's start identity changes across renders.
  const startRef = useRef(options.start)
  useEffect(() => {
    startRef.current = options.start
  })

  useEffect(() => {
    if (!hasBridge()) {
      return
    }
    let disposed = false
    let confirmTimer: ReturnType<typeof setTimeout> | null = null
    let unlisten: (() => void) | null = null
    void (async () => {
      try {
        const status = await nativeRecordingStatus()
        if (status.recording) {
          const result = await stopActiveRecording()
          if (result !== null) {
            enqueueStaged({
              blob: result.blob,
              recordedAt: result.recordedAt,
              stagedPath: result.stagedPath,
            })
          }
        }
      } catch (cause) {
        // A user stop or native finalize winning the race lands here — the
        // memo arrives through that path (or the orphan scan) instead.
        console.warn('reconciling a live native recording failed:', cause)
      }
      if (disposed) {
        return
      }
      try {
        const listener = await addPluginListener('recording', 'nativeAction', (raw: unknown) => {
          const parsed = nativeActionSchema.safeParse(raw)
          if (disposed || !parsed.success || parsed.data.action !== 'recordAudio') {
            return
          }
          void startRef.current()
          // A repeat delivery (double widget open, or a re-`deliverPendingAction`
          // while the action is still queued) restarts the confirm window
          // against the latest start — otherwise an earlier timer could
          // confirm before this start's UI has survived its full window.
          if (confirmTimer !== null) {
            clearTimeout(confirmTimer)
          }
          // Confirmation is about delivery, not success — a mic-denied start
          // still confirms, or the queue would re-surface the same failure
          // every launch.
          confirmTimer = setTimeout(() => {
            void invoke('plugin:recording|action_performed').catch((cause: unknown) => {
              console.warn('confirming a native action failed:', cause)
            })
          }, ACTION_CONFIRM_DELAY_MS)
        })
        if (disposed) {
          void listener.unregister()
          return
        }
        unlisten = () => void listener.unregister()
        await invoke('plugin:recording|actions_ready')
      } catch (cause) {
        console.error('the native-action handshake is unavailable:', cause)
      }
    })()
    return () => {
      disposed = true
      if (confirmTimer !== null) {
        clearTimeout(confirmTimer)
      }
      unlisten?.()
    }
  }, [enqueueStaged])
}
