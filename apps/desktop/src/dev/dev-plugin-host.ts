import { ReflectError, type Unlisten } from '@reflect/core'
import { z } from 'zod'

const startArgsSchema = z.object({ request: z.object({ maxDurationMs: z.number() }) })
const stagedPathArgsSchema = z.object({ request: z.object({ path: z.string() }) })

const LEVEL_INTERVAL_MS = 100

/** Base64 stand-in bytes: the ingest flow works end to end, playback won't. */
const FAKE_RECORDING_BASE64 = btoa('reflect dev recording')

/**
 * The browser stand-in for the two first-party plugins (`tauri-plugin-keyboard`,
 * `tauri-plugin-recording`): an in-memory recorder state machine plus staging
 * map, so the audio-memo machinery (record, native stop, orphan scan, the
 * OS-action handshake) can run end to end in the browser harness. The
 * keyboard half reports a closed keyboard — a desktop browser has no overlap
 * to mirror. Queue a fake OS entry point from the console:
 * `__reflectDev.plugins.queueAction('recordAudio')`.
 */
export interface DevPluginHost {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>
  listen(plugin: string, event: string, handler: (payload: unknown) => void): Unlisten
  /** What the Rust shell does on a `reflect://record-audio` deep link. */
  queueAction(action: string): void
}

export function createDevPluginHost(): DevPluginHost {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const staged = new Map<string, { base64: string; modifiedMs: number }>()
  let recording: { startedMs: number; capTimer: ReturnType<typeof setTimeout> } | null = null
  let levelTimer: ReturnType<typeof setInterval> | null = null
  let pendingAction: string | null = null
  let actionsReady = false

  function emit(plugin: string, event: string, payload: unknown): void {
    for (const handler of listeners.get(`${plugin}:${event}`) ?? []) {
      handler(payload)
    }
  }

  function stopTimers(): void {
    if (recording !== null) {
      clearTimeout(recording.capTimer)
    }
    if (levelTimer !== null) {
      clearInterval(levelTimer)
      levelTimer = null
    }
  }

  /** Move the live recording into staging; returns the stop response. */
  function finalize(): { path: string; durationMs: number; modifiedMs: number } {
    if (recording === null) {
      throw new ReflectError('io', 'no active recording')
    }
    const durationMs = Date.now() - recording.startedMs
    const modifiedMs = Date.now()
    const path = `/dev-staging/recording-${modifiedMs}.m4a`
    staged.set(path, { base64: FAKE_RECORDING_BASE64, modifiedMs })
    stopTimers()
    recording = null
    return { path, durationMs, modifiedMs }
  }

  function deliverPendingAction(): void {
    if (actionsReady && pendingAction !== null) {
      emit('recording', 'nativeAction', { action: pendingAction })
    }
  }

  async function invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'plugin:keyboard|current_height':
        return { height: 0, duration: 0 }
      case 'plugin:keyboard|impact_light':
        return null

      case 'plugin:recording|start_recording': {
        if (recording !== null) {
          throw new ReflectError('io', 'already recording')
        }
        const { maxDurationMs } = startArgsSchema.parse(args).request
        const startedMs = Date.now()
        recording = {
          startedMs,
          // The cap is a native-initiated stop, like an interruption on iOS.
          capTimer: setTimeout(() => {
            const response = finalize()
            emit('recording', 'recordingStopped', { ...response, reason: 'cap' })
          }, maxDurationMs),
        }
        levelTimer = setInterval(() => {
          const elapsedMs = Date.now() - startedMs
          emit('recording', 'recordingLevel', {
            level: 0.2 + 0.6 * Math.abs(Math.sin(elapsedMs / 300)),
            elapsedMs,
          })
        }, LEVEL_INTERVAL_MS)
        return null
      }
      case 'plugin:recording|stop_recording':
        return finalize()
      case 'plugin:recording|cancel_recording': {
        stopTimers()
        recording = null
        return null
      }
      case 'plugin:recording|recording_status':
        return recording === null
          ? { recording: false, elapsedMs: 0 }
          : { recording: true, elapsedMs: Date.now() - recording.startedMs }

      case 'plugin:recording|actions_ready': {
        actionsReady = true
        deliverPendingAction()
        return null
      }
      case 'plugin:recording|action_performed': {
        pendingAction = null
        return null
      }

      case 'plugin:recording|list_staged':
        return {
          files: [...staged]
            .map(([path, file]) => ({ path, modifiedMs: file.modifiedMs }))
            .sort((first, second) => first.path.localeCompare(second.path)),
        }
      case 'plugin:recording|read_staged': {
        const { path } = stagedPathArgsSchema.parse(args).request
        const file = staged.get(path)
        if (file === undefined) {
          throw new ReflectError('notFound', `no staged recording: ${path}`)
        }
        return { base64: file.base64 }
      }
      case 'plugin:recording|delete_staged': {
        staged.delete(stagedPathArgsSchema.parse(args).request.path)
        return null
      }

      default:
        console.error(`[dev-bridge] unimplemented plugin command "${command}"`, args)
        throw new ReflectError('unknown', `dev bridge: unimplemented plugin command "${command}"`)
    }
  }

  return {
    invoke,
    listen: (plugin, event, handler) => {
      const key = `${plugin}:${event}`
      const handlers = listeners.get(key) ?? new Set()
      handlers.add(handler)
      listeners.set(key, handlers)
      return () => {
        handlers.delete(handler)
      }
    },
    queueAction: (action) => {
      pendingAction = action
      deliverPendingAction()
    },
  }
}
