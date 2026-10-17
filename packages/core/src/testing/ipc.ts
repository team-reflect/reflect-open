import type { LoggerService } from '../ports/logger-service.ts'
import { createTestLoggerService } from './logger.ts'
import { AppError } from '../errors.ts'
import type { ZodType } from 'zod'
import {
  createIpcBridgeService,
  type IpcBridge,
  type IpcBridgeService,
  type PluginSubscription,
} from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'

type CommandHandler = (args: Record<string, unknown>) => unknown
type BinaryCommandHandler = (body: Uint8Array, headers: Record<string, string>) => unknown

export interface TestIpcBridgeService extends IpcBridgeService {
  /**
   * The in-memory transport the service wraps.
   */
  readonly transport: IpcBridge
  onCommand(command: string, handler: (args: Record<string, unknown>) => unknown): void
  onBinaryCommand(
    command: string,
    handler: (body: Uint8Array, headers: Record<string, string>) => unknown,
  ): void
  emit(event: string, payload: unknown): void
  emitPlugin(plugin: string, event: string, payload: unknown): void
  calls(): readonly { command: string; args: Record<string, unknown> }[]
}

export interface TestIpcBridgeServiceOptions {
  commands?: Record<string, CommandHandler> | undefined
  /**
   * Give the transport a binary path. Defaults to `true`.
   */
  binary?: boolean | undefined
  /**
   * Give the transport plugin events. Defaults to `true`.
   */
  pluginEvents?: boolean | undefined
  logger?: LoggerService | undefined
}

class TestIpcTransport implements IpcBridge {
  readonly #commands: Map<string, CommandHandler>
  readonly #binaryCommands = new Map<string, BinaryCommandHandler>()
  readonly #eventHandlers = new Map<string, Set<(payload: unknown) => void>>()
  readonly #pluginHandlers = new Map<string, Set<(payload: unknown) => void>>()
  readonly #log: { command: string; args: Record<string, unknown> }[] = []

  readonly invokeBinary?: (
    command: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ) => Promise<unknown>
  readonly listenPlugin?: (
    plugin: string,
    event: string,
    handler: (payload: unknown) => void,
  ) => Promise<void>

  constructor(options: TestIpcBridgeServiceOptions | undefined) {
    this.#commands = new Map<string, CommandHandler>(Object.entries(options?.commands ?? {}))
    if (options?.binary ?? true) {
      this.invokeBinary = async (command, body, headers) => {
        this.#log.push({ command, args: { headers } })
        const handler = this.#binaryCommands.get(command)
        if (handler === undefined) {
          throw new AppError('unknown', `test bridge: unimplemented command "${command}"`)
        }
        return await handler(body, headers)
      }
    }
    if (options?.pluginEvents ?? true) {
      this.listenPlugin = async (plugin, event, handler) => {
        this.#addHandler(this.#pluginHandlers, `${plugin}:${event}`, handler)
      }
    }
  }

  async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    this.#log.push({ command, args })
    const handler = this.#commands.get(command)
    if (handler === undefined) {
      throw new AppError('unknown', `test bridge: unimplemented command "${command}"`)
    }
    return await handler(args)
  }

  async listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten> {
    return this.#addHandler(this.#eventHandlers, event, handler)
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.#commands.set(command, handler)
  }

  onBinaryCommand(command: string, handler: BinaryCommandHandler): void {
    this.#binaryCommands.set(command, handler)
  }

  emit(event: string, payload: unknown): void {
    this.#dispatch(this.#eventHandlers, event, payload)
  }

  emitPlugin(plugin: string, event: string, payload: unknown): void {
    this.#dispatch(this.#pluginHandlers, `${plugin}:${event}`, payload)
  }

  calls(): readonly { command: string; args: Record<string, unknown> }[] {
    return [...this.#log]
  }

  #addHandler(
    registry: Map<string, Set<(payload: unknown) => void>>,
    key: string,
    handler: (payload: unknown) => void,
  ): Unlisten {
    let handlers = registry.get(key)
    if (handlers === undefined) {
      handlers = new Set()
      registry.set(key, handlers)
    }
    // Wrapped for identity, so registering one function twice detaches independently.
    const deliver = (payload: unknown): void => {
      handler(payload)
    }
    handlers.add(deliver)
    return () => {
      handlers.delete(deliver)
    }
  }

  #dispatch(
    registry: Map<string, Set<(payload: unknown) => void>>,
    key: string,
    payload: unknown,
  ): void {
    for (const handler of registry.get(key) ?? []) {
      handler(payload)
    }
  }
}

/**
 * Forwards every member to the real service over an in-memory transport.
 */
class TestIpcBridgeServiceImpl implements TestIpcBridgeService {
  readonly #inner: IpcBridgeService
  readonly #transport: TestIpcTransport

  readonly transport: IpcBridge
  readonly hasBinaryTransport: boolean

  constructor(options: TestIpcBridgeServiceOptions | undefined) {
    this.#transport = new TestIpcTransport(options)
    this.transport = this.#transport
    this.#inner = createIpcBridgeService({
      transport: this.#transport,
      logger: options?.logger ?? createTestLoggerService(),
    })
    this.hasBinaryTransport = this.#inner.hasBinaryTransport
  }

  call<TOutput>(
    command: string,
    args: Record<string, unknown>,
    schema: ZodType<TOutput, unknown>,
  ): Promise<TOutput> {
    return this.#inner.call(command, args, schema)
  }

  callBinary<TOutput>(
    command: string,
    body: Uint8Array,
    headers: Record<string, string>,
    schema: ZodType<TOutput, unknown>,
  ): Promise<TOutput> {
    return this.#inner.callBinary(command, body, headers, schema)
  }

  listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten> {
    return this.#inner.listen(event, handler)
  }

  listenPlugin(plugin: string, event: string, handler: (payload: unknown) => void): Promise<void> {
    return this.#inner.listenPlugin(plugin, event, handler)
  }

  subscribePlugin<Payload>(
    plugin: string,
    event: string,
    schema: ZodType<Payload, unknown>,
    handler: (payload: Payload) => void,
  ): PluginSubscription {
    return this.#inner.subscribePlugin(plugin, event, schema, handler)
  }

  onCommand(command: string, handler: (args: Record<string, unknown>) => unknown): void {
    this.#transport.onCommand(command, handler)
  }

  onBinaryCommand(
    command: string,
    handler: (body: Uint8Array, headers: Record<string, string>) => unknown,
  ): void {
    this.#transport.onBinaryCommand(command, handler)
  }

  emit(event: string, payload: unknown): void {
    this.#transport.emit(event, payload)
  }

  emitPlugin(plugin: string, event: string, payload: unknown): void {
    this.#transport.emitPlugin(plugin, event, payload)
  }

  calls(): readonly { command: string; args: Record<string, unknown> }[] {
    return this.#transport.calls()
  }
}

/**
 * An in-memory {@link IpcBridgeService}. Commands answer from registered
 * handlers; an unregistered command rejects with an `unknown` `AppError`.
 */
export function createTestIpcBridgeService(
  options?: TestIpcBridgeServiceOptions,
): TestIpcBridgeService {
  return new TestIpcBridgeServiceImpl(options)
}
