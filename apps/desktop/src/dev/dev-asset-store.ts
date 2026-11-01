import { appleFileSrc, type FileMeta, type FileSrcSource } from '@reflect/core'

/**
 * One in-memory asset: its bytes, a last-modified stamp, and the `blob:` URL
 * that serves it once an image asks for one.
 */
interface DevAsset {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly modifiedMs: number
  url: string | null
}

/**
 * The dev bridge's binary files: an in-memory map of graph-relative paths to
 * bytes, standing in for the Rust shell's asset commands. It also serves the
 * bytes to the webview through `blob:` URLs.
 */
export interface DevAssetStore extends FileSrcSource {
  /**
   * Every stored asset (`list_attachments`).
   */
  list(): FileMeta[]
  exists(path: string): boolean
  /**
   * An asset's bytes, or `null` when the path doesn't exist.
   */
  read(path: string): Uint8Array<ArrayBuffer> | null
  /**
   * Write an asset, replacing any bytes already at `path`.
   */
  write(path: string, bytes: Uint8Array<ArrayBuffer>): void
}

class DevAssetStoreImpl implements DevAssetStore {
  readonly #assets = new Map<string, DevAsset>()

  list(): FileMeta[] {
    return [...this.#assets].map(([path, asset]) => ({
      path,
      size: asset.bytes.byteLength,
      modifiedMs: asset.modifiedMs,
    }))
  }

  exists(path: string): boolean {
    return this.#assets.has(path)
  }

  read(path: string): Uint8Array<ArrayBuffer> | null {
    return this.#assets.get(path)?.bytes ?? null
  }

  write(path: string, bytes: Uint8Array<ArrayBuffer>): void {
    const previous = this.#assets.get(path)?.url
    if (previous !== undefined && previous !== null) {
      URL.revokeObjectURL(previous)
    }
    this.#assets.set(path, { bytes, modifiedMs: Date.now(), url: null })
  }

  convertFileSrc(filePath: string, protocol: string): string {
    // Asset URLs carry a `<generation>/` prefix before the graph path.
    const asset = this.#assets.get(filePath.replace(/^\d+\//, ''))
    if (asset === undefined) {
      return appleFileSrc(filePath, protocol)
    }
    asset.url ??= URL.createObjectURL(new Blob([asset.bytes]))
    return asset.url
  }
}

/**
 * Create an empty in-memory asset store.
 */
export function createDevAssetStore(): DevAssetStore {
  return new DevAssetStoreImpl()
}
