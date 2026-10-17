import type { MaybePromise } from '@reflect/utils'
import type { ZodType } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import { toAppError, type AppError } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * The shell's broadcast after an index write command commits.
 */
export const INDEX_WRITTEN_EVENT = 'index:written'

/**
 * The raw transport a host implements: the desktop app adapts Tauri's
 * `invoke`/`listen`, plain-browser dev installs an in-memory bridge, and
 * tests use a fake. {@link createIpcBridgeService} wraps it with validation
 * and error coercion.
 */
export interface IpcBridge {
  /**
   * Invoke a native command, resolving with its raw (untyped) response.
   */
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>
  /**
   * Subscribe to a native event stream, resolving with an unlisten function.
   */
  listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten>
  /**
   * Invoke a native command with a **raw binary body** instead of JSON args —
   * asset bytes cross the IPC without base64 inflation. Since a raw body
   * carries no args, per-call metadata travels in `headers`. Optional: hosts
   * without a binary transport simply don't stream assets; `callBinary`
   * throws loudly rather than degrading.
   */
  invokeBinary?: (
    command: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ) => Promise<unknown>
  /**
   * Attach a handler to a plugin's event stream, Tauri's
   * `addPluginListener` channel (`recordingLevel`, ...), which is distinct
   * from the global event bus behind {@link listen}.
   */
  listenPlugin?: (
    plugin: string,
    event: string,
    handler: (payload: unknown) => void,
  ) => Promise<void>
}

/**
 * A live plugin-event subscription. Registration is asynchronous (an IPC
 * round-trip) and shared per event, so the two concerns are split: `ready`
 * reports the (possibly shared) registration outcome; `unlisten` is a
 * purely local, synchronous detach from the fan-out. There is no native
 * unregistration that could fail: the underlying listener is kept for the
 * service's lifetime. Callers should observe `ready`
 * (`void sub.ready.catch(...)`) to log a host without the event stream.
 */
export interface PluginSubscription {
  ready: Promise<void>
  unlisten: Unlisten
}

/**
 * The typed IPC boundary: the single place where an untyped native response
 * becomes a validated domain value. Every failure is an {@link AppError}: a
 * rejected command is coerced via {@link toAppError}; a response that doesn't
 * match its schema becomes a `parse` error.
 */
export interface IpcBridgeService {
  /**
   * Invoke a `#[tauri::command]` (snake_case name) and validate the response.
   * The schema input is `unknown`, not `TOutput`: schemas that normalize
   * (`.catch`, `.default`) have a wider input type than output.
   */
  call<TOutput>(
    command: string,
    args: Record<string, unknown>,
    schema: ZodType<TOutput, unknown>,
  ): Promise<TOutput>
  /**
   * {@link call}'s binary sibling: the payload is a raw byte body with
   * per-call metadata in `headers`. Rejects with an `io` {@link AppError}
   * when the transport has no binary path.
   */
  callBinary<TOutput>(
    command: string,
    body: Uint8Array,
    headers: Record<string, string>,
    schema: ZodType<TOutput, unknown>,
  ): Promise<TOutput>
  /**
   * Subscribe to a native event stream, resolving with an unlisten function.
   */
  listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten>
  /**
   * Attach a raw handler to a plugin event stream. Rejects with an `io`
   * {@link AppError} when the transport has no plugin events.
   */
  listenPlugin(plugin: string, event: string, handler: (payload: unknown) => void): Promise<void>
  /**
   * Subscribe to a plugin event with schema-validated payloads. All
   * subscribers of one event share a single native registration, created on
   * the first subscribe and kept afterwards; a failed registration is dropped
   * so the next subscriber retries. Malformed payloads are dropped with a
   * warning.
   */
  subscribePlugin<Payload>(
    plugin: string,
    event: string,
    schema: ZodType<Payload, unknown>,
    handler: (payload: Payload) => void,
  ): PluginSubscription
  /**
   * True when the transport can carry raw binary bodies.
   */
  readonly hasBinaryTransport: boolean
}

interface SharedListener<Payload> {
  ready: Promise<void>
  fanOut: FanOut<Payload>
}

export interface IpcBridgeServiceDeps {
  readonly transport: IpcBridge
  readonly logger: LoggerService
}

class IpcBridgeServiceImpl implements IpcBridgeService {
  readonly #deps: IpcBridgeServiceDeps
  // Heterogeneous (each key carries its own payload type), so entries are
  // stored erased; `subscribePlugin` restores the type its schema defines.
  readonly #pluginListeners = new Map<string, SharedListener<never>>()

  readonly hasBinaryTransport: boolean

  constructor(deps: IpcBridgeServiceDeps) {
    this.#deps = deps
    this.hasBinaryTransport = deps.transport.invokeBinary !== undefined
  }

  async call<TOutput>(
    command: string,
    args: Record<string, unknown>,
    schema: ZodType<TOutput, unknown>,
  ): Promise<TOutput> {
    let raw: unknown
    try {
      raw = await this.#deps.transport.invoke(command, args)
    } catch (error) {
      throw toAppError(error)
    }
    return parseResponse(command, raw, schema)
  }

  async callBinary<TOutput>(
    command: string,
    body: Uint8Array,
    headers: Record<string, string>,
    schema: ZodType<TOutput, unknown>,
  ): Promise<TOutput> {
    const { transport } = this.#deps
    if (transport.invokeBinary === undefined) {
      const appError: AppError = {
        kind: 'io',
        message: `the installed IPC bridge has no binary transport for "${command}"`,
      }
      throw appError
    }
    let raw: unknown
    try {
      raw = await transport.invokeBinary(command, body, headers)
    } catch (error) {
      throw toAppError(error)
    }
    return parseResponse(command, raw, schema)
  }

  listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten> {
    return this.#deps.transport.listen(event, handler)
  }

  async listenPlugin(
    plugin: string,
    event: string,
    handler: (payload: unknown) => void,
  ): Promise<void> {
    const { transport } = this.#deps
    if (transport.listenPlugin === undefined) {
      throw noPluginEvents(plugin, event)
    }
    await transport.listenPlugin(plugin, event, handler)
  }

  subscribePlugin<Payload>(
    plugin: string,
    event: string,
    schema: ZodType<Payload, unknown>,
    handler: (payload: Payload) => void,
  ): PluginSubscription {
    const key = `${plugin}:${event}`
    let entry = this.#pluginListeners.get(key) as SharedListener<Payload> | undefined
    if (entry === undefined) {
      const fanOut = createFanOut<Payload>()
      entry = {
        fanOut,
        ready: this.#registerSharedListener(key, plugin, event, schema, (value) => {
          fanOut.emit(value)
        }),
      }
      // A missing `listenPlugin` rejects before this line, so that
      // rejection stays cached: the transport will never gain plugin events.
      this.#pluginListeners.set(key, entry as unknown as SharedListener<never>)
    }
    return {
      ready: entry.ready,
      unlisten: entry.fanOut.subscribe(handler),
    }
  }

  async #registerSharedListener<Payload>(
    key: string,
    plugin: string,
    event: string,
    schema: ZodType<Payload, unknown>,
    emit: (payload: Payload) => void,
  ): Promise<void> {
    const { transport, logger } = this.#deps
    try {
      if (transport.listenPlugin === undefined) {
        throw noPluginEvents(plugin, event)
      }
      await transport.listenPlugin(plugin, event, (raw) => {
        const parsed = schema.safeParse(raw)
        if (!parsed.success) {
          logger.warn(`dropping a malformed "${plugin}:${event}" payload`, parsed.error)
          return
        }
        emit(parsed.data)
      })
    } catch (error) {
      this.#pluginListeners.delete(key)
      throw error
    }
  }
}

function parseResponse<TOutput>(
  command: string,
  raw: unknown,
  schema: ZodType<TOutput, unknown>,
): TOutput {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const appError: AppError = {
      kind: 'parse',
      message: `unexpected response shape from "${command}": ${result.error.message}`,
    }
    throw appError
  }
  return result.data
}

function noPluginEvents(plugin: string, event: string): AppError {
  return {
    kind: 'io',
    message: `the installed IPC bridge has no plugin events for "${plugin}:${event}"`,
  }
}

export function createIpcBridgeService(deps: IpcBridgeServiceDeps): IpcBridgeService {
  return new IpcBridgeServiceImpl(deps)
}

/**
 * A set of handlers fed by one shared source.
 */
export interface FanOut<T> {
  /**
   * Add a handler and return its detach. The first handler starts the source;
   * the last detach stops it.
   */
  subscribe(handler: (value: T) => void): Unlisten
  /**
   * Deliver `value` to every current handler.
   */
  emit(value: T): void
}

class FanOutImpl<T> implements FanOut<T> {
  readonly #start: ((emit: (value: T) => void) => Unlisten) | undefined
  readonly #handlers = new Set<(value: T) => void>()
  #stop: Unlisten | null = null

  constructor(start: ((emit: (value: T) => void) => Unlisten) | undefined) {
    this.#start = start
  }

  subscribe(handler: (value: T) => void): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (value: T): void => {
      handler(value)
    }
    this.#handlers.add(deliver)
    if (this.#stop === null && this.#start !== undefined) {
      this.#stop = this.#start((value) => {
        this.emit(value)
      })
    }
    return () => {
      if (!this.#handlers.delete(deliver) || this.#handlers.size > 0 || this.#stop === null) {
        return
      }
      const teardown = this.#stop
      this.#stop = null
      teardown()
    }
  }

  emit(value: T): void {
    for (const handler of this.#handlers) {
      handler(value)
    }
  }
}

/**
 * Create a {@link FanOut}. `start` registers the shared source, feeding it
 * `emit`, and returns its teardown; without it, values arrive only through
 * `emit`.
 */
export function createFanOut<T>(start?: (emit: (value: T) => void) => Unlisten): FanOut<T> {
  return new FanOutImpl(start)
}

/**
 * Run an asynchronous subscription and return its teardown at once. The
 * teardown also cancels a registration that lands later; a failed
 * registration goes to `onError`.
 */
export function listenNow(
  register: () => MaybePromise<Unlisten>,
  onError: (cause: unknown) => void,
): Unlisten {
  let disposed = false
  let unlisten: Unlisten | null = null
  let pending: Promise<Unlisten>
  try {
    pending = Promise.resolve(register())
  } catch (error) {
    pending = Promise.reject(error)
  }
  void pending.then(
    (registered) => {
      if (disposed) {
        registered()
      } else {
        unlisten = registered
      }
    },
    (error: unknown) => {
      if (!disposed) {
        onError(error)
      }
    },
  )
  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}
