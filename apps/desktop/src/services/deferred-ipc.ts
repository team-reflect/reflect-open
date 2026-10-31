import {
  appleFileSrc,
  type FileSrcConverter,
  type FileSrcSource,
  type IpcBridge,
} from '@reflect/core'

/**
 * An IPC transport whose calls wait for {@link DeferredIpcTransport.connect}.
 */
export interface DeferredIpcTransport {
  readonly transport: IpcBridge
  /**
   * The connected transport's file URLs, or the Apple custom-scheme shape.
   */
  readonly convertFileSrc: FileSrcConverter
  /**
   * Supply the real transport, and optionally the URLs that serve its files.
   * Throws on a second call.
   */
  connect(bridge: IpcBridge, fileSrc?: FileSrcSource): void
}

class DeferredIpcTransportImpl implements DeferredIpcTransport {
  #resolveBridge: ((bridge: IpcBridge) => void) | null = null
  readonly #ready = new Promise<IpcBridge>((resolve) => {
    this.#resolveBridge = resolve
  })
  #connected = false
  #fileSrc: FileSrcSource | undefined

  readonly transport: IpcBridge = {
    invoke: async (command, args) => await (await this.#ready).invoke(command, args),
    invokeBinary: async (command, body, headers) => {
      const bridge = await this.#ready
      if (bridge.invokeBinary === undefined) {
        throw new Error(`the connected IPC transport has no binary path for "${command}"`)
      }
      return await bridge.invokeBinary(command, body, headers)
    },
    listen: async (event, handler) => await (await this.#ready).listen(event, handler),
    listenPlugin: async (plugin, event, handler) => {
      const bridge = await this.#ready
      if (bridge.listenPlugin === undefined) {
        throw new Error(`the connected IPC transport has no plugin events for "${plugin}:${event}"`)
      }
      await bridge.listenPlugin(plugin, event, handler)
    },
  }

  readonly convertFileSrc: FileSrcConverter = (filePath, protocol) => {
    return this.#fileSrc?.convertFileSrc(filePath, protocol) ?? appleFileSrc(filePath, protocol)
  }

  connect(bridge: IpcBridge, fileSrc?: FileSrcSource): void {
    if (this.#connected) {
      throw new Error('the deferred IPC transport is already connected')
    }
    this.#connected = true
    this.#fileSrc = fileSrc
    this.#resolveBridge?.(bridge)
  }
}

/**
 * A transport for a host whose real transport is created asynchronously
 * after the services are composed.
 */
export function createDeferredIpcTransport(): DeferredIpcTransport {
  return new DeferredIpcTransportImpl()
}
