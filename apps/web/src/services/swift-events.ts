import { AppError, type LoggerService, type Unlisten } from '@reflect/core'

type Handler = (payload: unknown) => void

/**
 * The most events of one name that wait for their first listener.
 */
const PENDING_LIMIT = 64

/**
 * The events of the Swift shell. The shell delivers an event with
 * `dispatch(name, payload)`, and every handler of `name` runs. An event whose
 * name has no listener yet waits: the first listener of that name gets the
 * waiting events in order, before any later event.
 */
export interface HostEvents {
  /**
   * Subscribe to a shell event; returns the unsubscribe.
   */
  on(name: string, handler: Handler): Unlisten
  /**
   * Deliver one event of the shell.
   */
  dispatch(name: string, payload: unknown): void
}

/**
 * The script message handler of the Swift shell. Its presence tells that the
 * Swift shell hosts the page.
 */
export interface SwiftMessageHandler {
  postMessage(message: unknown): void
}

declare global {
  interface Window {
    __reflectHost?: Pick<HostEvents, 'dispatch'> | undefined
    webkit?: { messageHandlers?: { reflectHost?: SwiftMessageHandler | undefined } | undefined }
  }
}

export function createHostEvents(logger: LoggerService): HostEvents {
  const listeners = new Map<string, Set<Handler>>()
  const pending = new Map<string, unknown[]>()

  function run(name: string, handler: Handler, payload: unknown): void {
    try {
      handler(payload)
    } catch (error) {
      logger.error(`A listener of "${name}" threw`, error)
    }
  }

  return {
    on(name, handler) {
      let handlers = listeners.get(name)
      if (handlers === undefined) {
        handlers = new Set()
        listeners.set(name, handlers)
      }
      handlers.add(handler)
      const waiting = pending.get(name)
      if (waiting !== undefined) {
        pending.delete(name)
        queueMicrotask(() => {
          for (const payload of waiting) {
            if (handlers.has(handler)) {
              run(name, handler, payload)
            }
          }
        })
      }
      return () => {
        handlers.delete(handler)
      }
    },
    dispatch(name, payload) {
      const handlers = listeners.get(name)
      if (handlers === undefined || handlers.size === 0) {
        const waiting = pending.get(name) ?? []
        waiting.push(payload)
        if (waiting.length > PENDING_LIMIT) {
          waiting.shift()
        }
        pending.set(name, waiting)
        return
      }
      for (const handler of handlers) {
        run(name, handler, payload)
      }
    },
  }
}

let hostEvents: HostEvents | undefined

/**
 * Give the Swift shell `target.__reflectHost.dispatch` and tell it that the
 * page takes events. The shell keeps its events until then.
 */
export function installHostEvents(target: Window, logger: LoggerService): void {
  const events = createHostEvents(logger)
  hostEvents = events
  target.__reflectHost = {
    dispatch: (name, payload) => {
      events.dispatch(name, payload)
    },
  }
  target.webkit?.messageHandlers?.reflectHost?.postMessage('ready')
}

/**
 * Subscribe to an event of the Swift shell. Throws an `io` error before
 * `installHostEvents`.
 */
export function listenHostEvent(name: string, handler: Handler): Unlisten {
  if (hostEvents === undefined) {
    throw new AppError('io', `no Swift host delivers "${name}"`)
  }
  return hostEvents.on(name, handler)
}
