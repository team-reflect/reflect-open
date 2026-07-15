import { attachmentRenderKind, type FileMeta, ReflectError } from '@reflect/core'

interface StoredAttachment {
  readonly contents: Uint8Array
  readonly modifiedMs: number
}

interface ObjectUrlApi {
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
}

/** Generation-scoped binary store used by the plain-browser development bridge. */
export interface DevAttachmentStore {
  readonly generation: number
  list: () => FileMeta[]
  has: (path: string) => boolean
  readBase64: (path: string) => string | null
  writeBase64: (path: string, contentsBase64: string) => void
  writeBytes: (path: string, contents: Uint8Array) => void
  /** Return a browser-loadable Blob URL only for an existing safe image. */
  displayUrl: (generation: number, path: string) => string | null
  /** Replace the graph session and revoke every URL owned by the previous one. */
  reset: (generation: number, seed?: Readonly<Record<string, string>>) => void
  /** Revoke every outstanding Blob URL and release all binary contents. */
  dispose: () => void
}

/**
 * Create the binary half of the in-memory dev filesystem. Attachments stay
 * private to this store and are exposed to the browser only through exact,
 * generation-pinned Blob URLs.
 */
export function createDevAttachmentStore(
  generation: number,
  seed: Readonly<Record<string, string>> = {},
  objectUrls: ObjectUrlApi = URL,
): DevAttachmentStore {
  let activeGeneration = generation
  const attachments = new Map<string, StoredAttachment>()
  const displayUrls = new Map<string, string>()

  function revoke(path: string): void {
    const url = displayUrls.get(path)
    if (url !== undefined) {
      objectUrls.revokeObjectURL(url)
      displayUrls.delete(path)
    }
  }

  function revokeAll(): void {
    for (const url of displayUrls.values()) {
      objectUrls.revokeObjectURL(url)
    }
    displayUrls.clear()
  }

  function writeBytes(path: string, contents: Uint8Array): void {
    assertSupportedAttachmentPath(path)
    revoke(path)
    attachments.set(path, { contents: contents.slice(), modifiedMs: Date.now() })
  }

  function writeBase64(path: string, contentsBase64: string): void {
    writeBytes(path, base64ToBytes(contentsBase64))
  }

  function replaceSeed(nextSeed: Readonly<Record<string, string>>): void {
    for (const [path, contentsBase64] of Object.entries(nextSeed)) {
      writeBase64(path, contentsBase64)
    }
  }

  replaceSeed(seed)

  return {
    get generation() {
      return activeGeneration
    },
    list: () =>
      [...attachments.entries()].map(([path, attachment]) => ({
        path,
        size: attachment.contents.byteLength,
        modifiedMs: attachment.modifiedMs,
      })),
    has: (path) => attachments.has(path),
    readBase64: (path) => {
      const attachment = attachments.get(path)
      return attachment === undefined ? null : bytesToBase64(attachment.contents)
    },
    writeBase64,
    writeBytes,
    displayUrl: (requestedGeneration, path) => {
      if (requestedGeneration !== activeGeneration || attachmentRenderKind(path) !== 'image') {
        return null
      }
      const attachment = attachments.get(path)
      if (attachment === undefined) {
        return null
      }
      const existing = displayUrls.get(path)
      if (existing !== undefined) {
        return existing
      }
      const url = objectUrls.createObjectURL(
        new Blob([attachment.contents.slice().buffer], { type: imageMimeType(path) }),
      )
      displayUrls.set(path, url)
      return url
    },
    reset: (nextGeneration, nextSeed = {}) => {
      revokeAll()
      attachments.clear()
      activeGeneration = nextGeneration
      replaceSeed(nextSeed)
    },
    dispose: () => {
      revokeAll()
      attachments.clear()
    },
  }
}

function assertSupportedAttachmentPath(path: string): void {
  if (attachmentRenderKind(path) === null) {
    throw new ReflectError('traversal', `unsupported or unsafe attachment path: ${path}`)
  }
}

function imageMimeType(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase()
  switch (extension) {
    case 'avif':
      return 'image/avif'
    case 'bmp':
      return 'image/bmp'
    case 'gif':
      return 'image/gif'
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

function base64ToBytes(contentsBase64: string): Uint8Array {
  const binary = atob(contentsBase64.replaceAll(/\s/g, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function bytesToBase64(contents: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < contents.length; offset += chunkSize) {
    binary += String.fromCharCode(...contents.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
