import {
  createGraphSession,
  requireGraphSession,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import { appleFileSrc } from '../ports/file-src.ts'
import {
  createAttachmentSaveScope,
  isManagedAssetPath,
  wikiEmbedDisplay,
  type AssetSaveError,
  type AssetSaveResult,
  type AttachFilesRequest,
  type AttachmentSaveScope,
  type AttachmentService,
  type WikiEmbedDisplay,
} from '../documents/attachment-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { assetFileName } from '../graph/asset-names.ts'
import {
  createAttachmentCatalog,
  resolveAttachmentLink,
  type AttachmentCatalog,
} from '../graph/attachment-resolution.ts'

export interface TestAttachmentEntry {
  path: string
  size: number
}

export interface TestAttachmentServiceOptions {
  /**
   * The attachment listing every generation's catalog is built from.
   */
  catalog?: readonly TestAttachmentEntry[]
  /**
   * Make `openOrReveal` fall back to a reveal, as for a refused file type.
   */
  refuseOpen?: boolean
  /**
   * Where the open graph is read from. Defaults to a graph of generation 1 that is always open.
   */
  graphSession?: GraphSessionSource
}

export interface AttachmentSave {
  name: string
  type: string
  size: number
  generation: number
  path: string
}

export interface TestAttachmentService extends AttachmentService {
  /**
   * Replace the listing without notifying `onCatalogChanged` listeners.
   */
  setCatalog(entries: readonly TestAttachmentEntry[]): void
  /**
   * Notify every `onCatalogChanged` listener.
   */
  emitCatalogChanged(): void
  /**
   * Make later saves fail with `error`; `null` makes them succeed again.
   */
  failSaves(error: AssetSaveError | null): void
  /**
   * Every successful save, in order.
   */
  saves(): readonly AttachmentSave[]
  /**
   * Every path opened, in order.
   */
  opened(): readonly string[]
  /**
   * Every path revealed, in order.
   */
  revealed(): readonly string[]
  /**
   * Every `attachFilesToNote` request, in order.
   */
  attachRequests(): readonly AttachFilesRequest[]
  /**
   * How many `watchCatalog` subscriptions are active.
   */
  watchers(): number
}

class TestAttachmentServiceImpl implements TestAttachmentService {
  readonly #options: TestAttachmentServiceOptions | undefined
  readonly #listeners = new Set<() => void>()
  readonly #saveLog: AttachmentSave[] = []
  readonly #openLog: string[] = []
  readonly #revealLog: string[] = []
  readonly #attachLog: AttachFilesRequest[] = []
  readonly #graphSession: GraphSessionSource
  #catalog: AttachmentCatalog
  #saveFailure: AssetSaveError | null = null
  #watching = 0

  constructor(options?: TestAttachmentServiceOptions) {
    this.#options = options
    this.#catalog = createAttachmentCatalog(options?.catalog ?? [])
    const defaultSession = createGraphSession({
      root: '/graphs/test',
      name: 'test',
      generation: 1,
      indexGeneration: 1,
    })
    this.#graphSession = options?.graphSession ?? {
      getState: () => ({ session: defaultSession }),
    }
  }

  peekCatalog(): AttachmentCatalog | null {
    return this.#openGeneration() === null ? null : this.#catalog
  }

  loadCatalog(): Promise<AttachmentCatalog> {
    return Promise.try(() => {
      requireGraphSession(this.#graphSession)
      return this.#catalog
    })
  }

  watchCatalog(): Unlisten {
    this.#watching += 1
    return () => {
      this.#watching -= 1
    }
  }

  onCatalogChanged(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  resolveAttachmentPath(notePath: string, destination: string): string | null {
    return this.#resolveAttachmentPath(notePath, destination, this.#openGeneration())
  }

  resolveAssetOpenPath(notePath: string, source: string): string | null {
    const generation = this.#openGeneration()
    if (generation === null) {
      return null
    }
    return (
      this.#resolveAttachmentPath(notePath, source, generation) ??
      (isManagedAssetPath(source) ? source : null)
    )
  }

  resolveImageUrl(notePath: string, source: string): string | undefined {
    return this.#resolveImageUrl(notePath, source, this.#openGeneration())
  }

  resolvePreviewImageUrl(
    notePath: string,
    source: string,
    generation: number,
  ): Promise<string | undefined> {
    return Promise.try(() => {
      const path = this.#resolveAttachmentPath(notePath, source, generation)
      if (path === null || path.toLowerCase().endsWith('.svg')) {
        return
      }
      const url = this.#resolveImageUrl(notePath, source, generation)
      return url === undefined ? undefined : `${url}?reflect-preview=raster`
    })
  }

  resolveWikiEmbed(target: string): WikiEmbedDisplay | undefined {
    return wikiEmbedDisplay(target)
  }

  claimsFileLink(notePath: string, href: string): boolean {
    return isManagedAssetPath(href) || resolveAttachmentLink(notePath, href, null) !== null
  }

  resolveFileInfo(notePath: string, href: string): Promise<{ size: number } | undefined> {
    return Promise.try(() => {
      const path = this.#resolveAttachmentPath(notePath, href, this.#openGeneration())
      const size = path === null ? undefined : this.#catalog.size(path)
      return size === undefined ? undefined : { size }
    })
  }

  saveFile(file: File): Promise<AssetSaveResult | null> {
    return Promise.try(() => {
      const generation = this.#openGeneration()
      if (generation === null) {
        return null
      }
      if (this.#saveFailure !== null) {
        return { ok: false, error: this.#saveFailure }
      }
      const path = `assets/${assetFileName(file.name)}`
      this.#saveLog.push({ name: file.name, type: file.type, size: file.size, generation, path })
      return { ok: true, path }
    })
  }

  createSaveScope(): AttachmentSaveScope {
    return createAttachmentSaveScope({ save: (file) => this.saveFile(file) })
  }

  attachFilesToNote(request: AttachFilesRequest): Promise<void> {
    if (this.#openGeneration() !== null) {
      this.#attachLog.push(request)
    }
    return Promise.resolve()
  }

  openOrReveal(path: string): Promise<void> {
    if (this.#openGeneration() === null) {
      return Promise.resolve()
    }
    if (this.#options?.refuseOpen === true) {
      this.#revealLog.push(path)
    } else {
      this.#openLog.push(path)
    }
    return Promise.resolve()
  }

  setCatalog(entries: readonly TestAttachmentEntry[]): void {
    this.#catalog = createAttachmentCatalog(entries)
  }

  emitCatalogChanged(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  failSaves(error: AssetSaveError | null): void {
    this.#saveFailure = error
  }

  saves(): readonly AttachmentSave[] {
    return [...this.#saveLog]
  }

  opened(): readonly string[] {
    return [...this.#openLog]
  }

  revealed(): readonly string[] {
    return [...this.#revealLog]
  }

  attachRequests(): readonly AttachFilesRequest[] {
    return [...this.#attachLog]
  }

  watchers(): number {
    return this.#watching
  }

  #openGeneration(): number | null {
    return this.#graphSession.getState().session?.generation ?? null
  }

  #resolveAttachmentPath(
    notePath: string,
    destination: string,
    generation: number | null,
  ): string | null {
    return generation === null ? null : resolveAttachmentLink(notePath, destination, this.#catalog)
  }

  #resolveImageUrl(
    notePath: string,
    source: string,
    generation: number | null,
  ): string | undefined {
    if (/^https?:\/\//i.test(source)) {
      return source
    }
    const path = this.#resolveAttachmentPath(notePath, source, generation)
    return path === null || generation === null
      ? undefined
      : appleFileSrc(`${generation}/${path}`, 'reflect-asset')
  }
}

/**
 * An in-memory {@link AttachmentService} whose catalog is always loaded.
 * Saves land at `assets/<sanitized name>`; image URLs use the Apple
 * `reflect-asset://localhost/` shape.
 */
export function createTestAttachmentService(
  options?: TestAttachmentServiceOptions,
): TestAttachmentService {
  return new TestAttachmentServiceImpl(options)
}
