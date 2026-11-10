import { AppError, toAppError, type IpcBridge } from '@reflect/core'
import { listenHostEvent } from '@/services/swift-host/host-events.ts'

const IPC_URL = 'reflect-app://localhost/__ipc/'

async function send(
  fetchFn: typeof fetch,
  command: string,
  body: BodyInit,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetchFn(`${IPC_URL}${encodeURIComponent(command)}`, {
    method: 'POST',
    body,
    headers,
  })
  if (!response.ok) {
    throw new AppError('io', `the Swift shell answered ${response.status} for "${command}"`)
  }
  const failed = response.headers.get('x-reflect-response') === 'error'
  const contentType = response.headers.get('content-type') ?? ''
  if (!failed && contentType.startsWith('application/octet-stream')) {
    return await response.arrayBuffer()
  }
  let json: unknown
  try {
    json = await response.json()
  } catch (error) {
    throw new AppError('parse', `the Swift shell answered no JSON for "${command}"`, {
      cause: error,
    })
  }
  if (failed) {
    throw toAppError(json)
  }
  return json
}

/**
 * The IPC bridge of the Swift shell. A command is a `POST` to
 * `reflect-app://localhost/__ipc/<command>`; the shell answers JSON, raw
 * bytes as `application/octet-stream`, or a `{ kind, message }` body flagged
 * by `x-reflect-response: error`. Events arrive through `window.__reflectHost`,
 * plugin events under `plugin:<plugin>:<event>`.
 */
export function createSwiftIpcTransport(fetchFn: typeof fetch): IpcBridge {
  return {
    invoke: (command, args) => {
      return send(fetchFn, command, JSON.stringify(args), { 'content-type': 'application/json' })
    },
    invokeBinary: (command, body, headers) => {
      // `fetch` takes no view over a `SharedArrayBuffer`: `slice` copies into a plain `ArrayBuffer`.
      return send(fetchFn, command, body.slice(), {
        ...headers,
        'content-type': 'application/octet-stream',
      })
    },
    listen: (event, handler) => {
      return Promise.resolve().then(() => listenHostEvent(event, handler))
    },
    listenPlugin: (plugin, event, handler) => {
      return Promise.resolve().then(() => {
        listenHostEvent(`plugin:${plugin}:${event}`, handler)
      })
    },
  }
}
