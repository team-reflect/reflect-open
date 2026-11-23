import {
  IAP_PRODUCT_IDS,
  AppError,
  pickFreeAssetPath,
  type CommandArgs,
  type CommandName,
  type IpcBridge,
} from '@reflect/core'
import type { AssetReadBinaryArgs } from '@reflect/types'
import { base64ToBytes, bytesToBase64, sha256Hex } from '@reflect/utils'
import type { DevAssetStore } from '@/dev/dev-asset-store.ts'
import type { DevFileStore } from '@/dev/dev-file-store.ts'
import { createWasmIndexBackend, type WasmIndexBackend } from '@reflect/index-wasm'

/**
 * The fixed fake graph root the dev bridge reports (mirrors `mobile_storage`).
 */
export const DEV_GRAPH_ROOT = '/dev-graph'

/**
 * Everything the command router needs.
 */
export interface DevBridgeBackend {
  readonly files: DevFileStore
  readonly assets: DevAssetStore
}

/**
 * The arguments of `command`, typed from the command table. The callers are
 * the typed `ipc.call` sites, so the bridge reads them without a check.
 */
function argsOf<C extends CommandName>(_command: C, args: Record<string, unknown>): CommandArgs<C> {
  return args as CommandArgs<C>
}

// Fixed preview prices, independent of App Store Connect and browser locale.
const iapProducts = [
  { productId: IAP_PRODUCT_IDS.monthly, formattedPrice: '$9999.99' },
  { productId: IAP_PRODUCT_IDS.yearly, formattedPrice: '$99999.99' },
]

class DevBridgeImpl implements IpcBridge {
  readonly #deps: DevBridgeBackend
  // The Rust index of the native shells, compiled to wasm.
  readonly #index: WasmIndexBackend
  readonly #graphInfo = { root: DEV_GRAPH_ROOT, name: 'Dev Graph', generation: 1 }
  #settingsDocument: Record<string, unknown> = { mobileOnboarded: true }
  readonly #uploads = new Map<string, Uint8Array<ArrayBuffer>[]>()
  #uploadCount = 0
  #ownedProductId: string | null = null
  // In-memory keychain stand-in so the AI-provider settings flow (and chat,
  // against a CORS-permissive provider) works end-to-end in the harness.
  readonly #secrets = new Map<string, string>()
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>()

  constructor(deps: DevBridgeBackend) {
    this.#deps = deps
    const { files } = deps
    this.#index = createWasmIndexBackend(
      {
        list: () => files.list(),
        move: (from, to) => {
          if (!files.move(from, to)) {
            throw new AppError('io', `cannot move note: ${from} to ${to}`)
          }
        },
      },
      (event, payload) => {
        this.#emit(event, payload)
      },
    )
  }

  invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    // The executor turns a synchronous throw into a rejection.
    return new Promise((resolve) => {
      resolve(this.#runCommand(command, args))
    })
  }

  invokeBinary(
    command: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      if (command !== 'asset_upload_append') {
        throw new AppError('unknown', `dev bridge: unimplemented binary command "${command}"`)
      }
      const id = headers['x-upload-id'] ?? ''
      this.#upload(id).push(new Uint8Array(body))
      resolve(null)
    })
  }

  #runCommand(command: string, args: Record<string, unknown>): unknown {
    const { files, assets } = this.#deps
    const index = this.#index
    switch (command) {
      case 'background_task_begin':
        // Browser previews are never suspended like an iOS process, so the
        // native finite-length assertion is honestly unavailable.
        return null
      case 'plugin:mobile-haptics|impact_light':
        return null
      case 'plugin:app-store|get_environment':
        return { environment: 'Sandbox' }
      case 'plugin:app-store|sync':
      case 'plugin:app-store|present_offer_code_redeem_sheet':
      case 'plugin:app-store|request_review':
        return null
      case 'plugin:iap|get_products': {
        const { payload } = argsOf('plugin:iap|get_products', args)
        return {
          products: iapProducts.filter((product) => payload.productIds.includes(product.productId)),
        }
      }
      case 'plugin:iap|get_product_status': {
        const { payload } = argsOf('plugin:iap|get_product_status', args)
        return { isOwned: payload.productId === this.#ownedProductId }
      }
      case 'plugin:iap|purchase': {
        const { payload } = argsOf('plugin:iap|purchase', args)
        if (!iapProducts.some((product) => product.productId === payload.productId)) {
          throw new AppError('notFound', `unknown preview product: ${payload.productId}`)
        }
        this.#ownedProductId = payload.productId
        return null
      }
      case 'mobile_storage':
        // No iCloud in a plain browser — the dev harness exercises the
        // local-storage path (and, via `mobileOnboarded` above, skips
        // onboarding entirely).
        return { localRoot: DEV_GRAPH_ROOT, icloudDocumentsRoot: null, icloudGraphRoots: [] }
      case 'mobile_storage_local':
        return DEV_GRAPH_ROOT
      case 'icloud_download_pending':
      case 'icloud_request_downloads':
        return 0
      case 'graph_open':
      case 'graph_create':
        return this.#graphInfo
      case 'recent_graphs':
        // One seeded recent so the desktop chooser has something to open —
        // the browser has no folder picker, so this is the only entry point.
        return [{ root: this.#graphInfo.root, name: this.#graphInfo.name, openedMs: Date.now() }]
      case 'icloud_status':
        // No iCloud container in a browser; the chooser's iCloud card hides.
        return { available: false, documentsRoot: null, existingGraphRoots: [] }
      case 'embed_status':
        // A browser has no embedding runtime.
        return { status: 'unsupported' }
      case 'vault_scan_stats':
        return { notes: files.list().length, attachments: assets.list().length, skipped: 0 }
      case 'forget_recent':
      case 'capture_host_register':
      case 'watch_start':
      case 'watch_stop':
      case 'background_task_end':
      case 'quit_confirm':
      case 'toggle_devtools':
        return null
      case 'capture_inbox_list':
        return []
      case 'capture_shared_inbox_relay':
        // No share-extension App Group inbox in a browser; nothing to relay.
        return 0
      case 'capture_quick_note_defaults_write':
        // No App Group container in a browser; nothing to mirror.
        return null

      case 'note_read': {
        const { path } = argsOf('note_read', args)
        const contents = files.read(path)
        if (contents === null) {
          throw new AppError('notFound', `no such note: ${path}`)
        }
        return contents
      }
      case 'note_read_local': {
        // The in-memory store has no iCloud, so a note is never evicted.
        const { path } = argsOf('note_read_local', args)
        const contents = files.read(path)
        if (contents === null) {
          throw new AppError('notFound', `no such note: ${path}`)
        }
        return { kind: 'content', content: contents }
      }
      case 'note_write': {
        const { path, contents, checkContents, expectedContents } = argsOf('note_write', args)
        if (checkContents === true) {
          const current = files.read(path)
          if (current !== (expectedContents ?? null) && current !== contents) {
            throw new AppError('io', 'Note changed on disk; reload before retrying')
          }
        }
        const modifiedMs = files.write(path, contents)
        return sha256Hex(contents).then((hash) => ({ modifiedMs, merged: null, hash }))
      }
      case 'note_create': {
        const { path, contents, generation } = argsOf('note_create', args)
        this.#checkGeneration(generation)
        return files.create(path, contents)
      }
      case 'note_exists':
        return files.exists(argsOf('note_exists', args).path)
      case 'note_delete': {
        files.remove(argsOf('note_delete', args).path)
        return null
      }
      case 'list_files':
        return files.list()
      case 'dir_list':
        return files.listDir(argsOf('dir_list', args).dir)
      case 'note_move_indexed': {
        const {
          request: { from, to },
          generation,
        } = argsOf('note_move_indexed', args)
        this.#checkGeneration(generation)
        if (!files.exists(from)) {
          throw new AppError('notFound', `cannot move note: ${from} does not exist`)
        }
        if (files.exists(to)) {
          throw new AppError('io', `cannot move note: ${to} already exists`)
        }
        // The index moves the rows, then the file; a refused file move puts
        // the rows back.
        index.invoke('note_move_indexed', args)
        return null
      }

      case 'asset_write': {
        const { path, contentsBase64, generation } = argsOf('asset_write', args)
        this.#checkGeneration(generation)
        assets.write(path, base64ToBytes(contentsBase64))
        return null
      }
      case 'asset_read':
        return bytesToBase64(this.#readAsset(argsOf('asset_read', args).path))
      case 'asset_read_binary':
        return this.#readAsset((args as AssetReadBinaryArgs).path).slice().buffer
      case 'list_attachments':
        return assets.list()
      case 'asset_upload_begin': {
        this.#checkGeneration(argsOf('asset_upload_begin', args).generation)
        this.#uploadCount += 1
        const id = `upload-${this.#uploadCount}`
        this.#uploads.set(id, [])
        return id
      }
      case 'asset_upload_commit': {
        const { id, desiredName, generation } = argsOf('asset_upload_commit', args)
        this.#checkGeneration(generation)
        const path = pickFreeAssetPath(desiredName, (candidate) => assets.exists(candidate))
        assets.write(path, this.#finishUpload(id))
        return path
      }
      case 'asset_upload_commit_path': {
        const { id, path, generation } = argsOf('asset_upload_commit_path', args)
        this.#checkGeneration(generation)
        const bytes = this.#finishUpload(id)
        if (assets.exists(path)) {
          throw new AppError('io', `target already exists: ${path}`)
        }
        assets.write(path, bytes)
        return null
      }
      case 'asset_upload_abort': {
        this.#uploads.delete(argsOf('asset_upload_abort', args).id)
        return null
      }
      case 'asset_open':
        return null
      case 'asset_reveal':
        return null

      case 'settings_load':
        return this.#settingsDocument
      case 'settings_save': {
        this.#settingsDocument = argsOf('settings_save', args).settings
        return null
      }
      case 'secret_get':
        return this.#secrets.get(argsOf('secret_get', args).name) ?? null
      case 'secret_set': {
        const { name, value } = argsOf('secret_set', args)
        this.#secrets.set(name, value)
        return null
      }
      case 'secret_delete': {
        this.#secrets.delete(argsOf('secret_delete', args).name)
        return null
      }

      case 'git_status':
        return {
          initialized: false,
          branch: null,
          remoteUrl: null,
          ahead: 0,
          behind: 0,
        }

      case 'calendar_authorization_status':
      case 'contacts_authorization_status':
        return 'denied'
      case 'calendar_list_calendars':
      case 'calendar_list_events':
      case 'contacts_lookup_by_email':
      case 'contacts_lookup_by_name':
        return []

      default:
        if (index.has(command)) {
          return index.invoke(command, args)
        }
        console.error(`[dev-bridge] unimplemented command "${command}"`, args)
        throw new AppError('unknown', `dev bridge: unimplemented command "${command}"`)
    }
  }

  #checkGeneration(generation: number): void {
    if (generation !== this.#graphInfo.generation) {
      throw new AppError('io', 'the graph changed since this command was issued; dropping it')
    }
  }

  #upload(id: string): Uint8Array<ArrayBuffer>[] {
    const chunks = this.#uploads.get(id)
    if (chunks === undefined) {
      throw new AppError('notFound', `unknown upload: ${id}`)
    }
    return chunks
  }

  #finishUpload(id: string): Uint8Array<ArrayBuffer> {
    const chunks = this.#upload(id)
    this.#uploads.delete(id)
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

  #readAsset(path: string): Uint8Array<ArrayBuffer> {
    const bytes = this.#deps.assets.read(path)
    if (bytes === null) {
      throw new AppError('notFound', `asset not found: ${path}`)
    }
    return bytes
  }

  // The index events (`index:written`, `note:moved`) fire like the native
  // broadcast: after the command that caused them has replied. The other native event streams (watcher, embeddings, EventKit)
  // do not exist in the browser: those subscriptions succeed and never fire.
  // Plugin event registrations do the same, so the keyboard and recorder
  // hooks mount in the harness.
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
    const handlers = this.#listeners.get(event) ?? new Set()
    this.#listeners.set(event, handlers)
    // One entry per registration: the same handler can listen twice.
    const deliver = (payload: unknown): void => {
      handler(payload)
    }
    handlers.add(deliver)
    return Promise.resolve(() => {
      handlers.delete(deliver)
    })
  }

  #emit(event: string, payload: unknown): void {
    for (const handler of this.#listeners.get(event) ?? []) {
      handler(payload)
    }
  }

  async listenPlugin(): Promise<void> {}
}

/**
 * The in-browser stand-in for the Rust shell (dev builds only): answers the
 * command surface the desktop and mobile trees exercise from an in-memory
 * file map and the Rust index compiled to wasm. The in-memory graph has one fixed
 * generation (`1`); the
 * no-clobber note-create command validates that value before touching the
 * store, matching its native race-safety contract.
 *
 * Anything unimplemented rejects loudly with the command name — a surface
 * quietly rendering empty because a stub answered wrong is worse than an
 * error naming the gap.
 */
export function createDevBridge(backend: DevBridgeBackend): IpcBridge {
  return new DevBridgeImpl(backend)
}
