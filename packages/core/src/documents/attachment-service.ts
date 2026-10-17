import type { MaybePromise } from '@reflect/utils'
import type { ClockService } from '../ports/clock-service.ts'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { FileSrcSource } from '../ports/file-src.ts'
import { errorMessage } from '../errors.ts'
import { assetFileName } from '../graph/asset-names.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import {
  createAttachmentCatalog,
  resolveAttachmentLink,
  resolveWikiEmbedTarget,
  type AttachmentCatalog,
} from '../graph/attachment-resolution.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { isAttachmentPath, isSafeVisibleGraphPath } from '../graph/paths.ts'
import type { FileMeta } from '../graph/schemas.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { formatBytes } from '../lib/format-bytes.ts'

/**
 * Above this size, a save gets a non-blocking status-line warning. Never a
 * wall (it's the user's disk), and not a modal either (the drop already
 * said what the user wants), but git backup is the quiet constraint: every
 * binary lives in history forever, and GitHub hard-rejects files over
 * 100 MB, so the size is worth a mention.
 */
export const LARGE_FILE_BYTES = 25 * 1024 * 1024

/**

 * The custom URI scheme the Rust shell serves graph attachments on.

 */
const ASSET_PROTOCOL = 'reflect-asset'

/**

 * Asset file extension for each image MIME type that gets `pasted-…` naming.

 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/**

 * How an Obsidian `![[target]]` embed renders.

 */
export type WikiEmbedDisplay =
  | { readonly kind: 'note' }
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'file'; readonly href: string }

/**

 * The failed save a note pane reports on: which banner copy, and the cause.

 */
export interface AssetSaveError {
  /**
   * 'image' for files named as pasted images, 'file' for everything else.
   */
  readonly kind: 'image' | 'file'
  readonly message: string
}

export type AssetSaveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: AssetSaveError }

/**
 * The save outcome of one note pane. {@link reset} starts a new note session:
 * a save that finishes after it no longer touches {@link error}.
 */
export interface AttachmentSaveScope {
  /**
   * Save `file` like {@link AttachmentService.saveFile}, resolving with the
   * saved path or null. A failure lands on {@link error}, never a rejection;
   * the next success clears it. With no graph open nothing is saved and
   * {@link error} stays.
   */
  saveFile(file: File): Promise<string | null>
  /**
   * The most recent failed save of this note session.
   */
  error(): AssetSaveError | null
  subscribe(listener: () => void): Unlisten
  reset(): void
}

/**

 * Where {@link AttachmentService.attachFilesToNote} inserts its links.

 */
export interface AttachmentInsertTarget {
  insertMarkdown(markdown: string): void
  focus(): void
}

export interface AttachFilesRequest {
  /**
   * The absolute source paths the user picked.
   */
  readonly sources: readonly string[]
  /**
   * The target note's mounted editor, or null; looked up again after every await.
   */
  readonly findEditor: () => AttachmentInsertTarget | null
}

/**
 * Note attachments (images, file pills, `![[embeds]]`): resolution against
 * the vault's attachment catalog, display URLs, opening, and saving new files
 * into `assets/`. Every graph-touching call is pinned to the generation of the
 * graph open when it is made.
 */
export interface AttachmentService {
  /**
   * The open graph's catalog, or null while its first listing loads or no graph is open.
   */
  peekCatalog(): AttachmentCatalog | null
  /**
   * The open graph's catalog, waiting for its first listing. Rejects when no graph is open.
   */
  loadCatalog(): Promise<AttachmentCatalog>
  /**
   * Load the catalog of `generation` and keep it fresh: re-list when a batch
   * names an attachment path, or on a reconcile request.
   */
  watchCatalog(generation: number): Unlisten
  /**
   * Called whenever a listing changes a catalog.
   */
  onCatalogChanged(listener: () => void): Unlisten
  /**
   * The graph-relative attachment a link or image destination in `notePath`
   * names, from the catalog as loaded so far; null for URLs, notes, unsafe
   * paths, and while no graph is open.
   */
  resolveAttachmentPath(notePath: string, destination: string): string | null
  /**
   * The attachment a link or image source opens: {@link resolveAttachmentPath},
   * or a managed `assets/` path as written.
   */
  resolveAssetOpenPath(notePath: string, source: string): string | null
  /**
   * A displayable URL for an image source: http(s) as-is, a local attachment
   * as a generation-pinned `reflect-asset://` URL. Answers synchronously once
   * the catalog is loaded and waits for it before that.
   */
  resolveImageUrl(notePath: string, source: string): MaybePromise<string | undefined>
  /**
   * The image URL for a passive preview in graph session `generation`: local
   * bitmaps only, served with a raster-only query. Remote images and SVGs
   * resolve to undefined.
   */
  resolvePreviewImageUrl(
    notePath: string,
    source: string,
    generation: number,
  ): Promise<string | undefined>
  /**
   * An attachment embed renders as an image or a file pill, a note as a link
   * chip to it, and an unsafe path stays literal (undefined).
   */
  resolveWikiEmbed(target: string): WikiEmbedDisplay | undefined
  /**
   * Whether a link in `notePath` is a local attachment to show as a file pill.
   */
  claimsFileLink(notePath: string, href: string): boolean
  /**
   * The size of a claimed attachment link or embed: a file saved this graph
   * session first, then the catalog. Undefined for anything else, a file the
   * catalog doesn't list, or a failed listing.
   */
  resolveFileInfo(notePath: string, href: string): Promise<{ size: number } | undefined>
  /**
   * Stream a pasted or dropped file into `assets/`. Known image types get
   * `pasted-<now>.<ext>` names; everything else keeps its sanitized original
   * name. Rust resolves name collisions. Files over {@link LARGE_FILE_BYTES}
   * get a status-line warning after they land. Resolves `null`, saving
   * nothing, when no graph is open.
   */
  saveFile(file: File): Promise<AssetSaveResult | null>
  createSaveScope(): AttachmentSaveScope
  /**
   * The Attach file… command: each picked source copied into
   * `assets/`, one `[name](assets/…)` link per landed file inserted into the
   * note's editor. Copy failures and a closed editor are reported as one
   * failed operation. Does nothing when no graph is open.
   */
  attachFilesToNote(request: AttachFilesRequest): Promise<void>
  /**
   * Open an attachment in its default app. A refused open falls back to
   * revealing the file; failures surface as operations, never a rejection.
   * Does nothing when no graph is open.
   */
  openOrReveal(path: string): Promise<void>
}

/**

 * A visible managed file, including formats that can only be revealed.

 */
export function isManagedAssetPath(path: string): boolean {
  return path.startsWith('assets/') && !path.includes('\0') && isSafeVisibleGraphPath(path)
}

/**

 * The attachment a source opens, given how the note resolves attachment destinations.

 */
function assetOpenPath(source: string, resolved: string | null): string | null {
  return resolved ?? (isManagedAssetPath(source) ? source : null)
}

function isSvgAsset(path: string): boolean {
  return path.toLowerCase().endsWith('.svg')
}

function previewRasterUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}reflect-preview=raster`
}

function basenameOf(sourcePath: string): string {
  const segments = sourcePath.split(/[/\\]/)
  return segments[segments.length - 1] ?? sourcePath
}

/**

 * Escape `\`, `[`, and `]` so a filename stays inside its `[text]` label.

 */
function escapeLinkLabel(name: string): string {
  return name.replaceAll(/[\\[\]]/g, String.raw`\$&`)
}

/**

 * How an Obsidian `![[target]]` embed renders; see {@link AttachmentService.resolveWikiEmbed}.

 */
export function wikiEmbedDisplay(target: string): WikiEmbedDisplay | undefined {
  const embed = resolveWikiEmbedTarget(target)
  if (embed === null) {
    return undefined
  }
  if (embed.kind === 'note') {
    return { kind: 'note' }
  }
  return embed.kind === 'image'
    ? { kind: 'image', src: embed.source }
    : { kind: 'file', href: embed.source }
}

export interface AttachmentSaveScopeDeps {
  readonly save: (file: File) => Promise<AssetSaveResult | null>
}

class AttachmentSaveScopeImpl implements AttachmentSaveScope {
  readonly #deps: AttachmentSaveScopeDeps
  readonly #listeners = new Set<() => void>()
  #epoch = 0
  #current: AssetSaveError | null = null

  constructor(deps: AttachmentSaveScopeDeps) {
    this.#deps = deps
  }

  async saveFile(file: File): Promise<string | null> {
    const started = this.#epoch
    const result = await this.#deps.save(file)
    if (result === null) {
      return null
    }
    if (this.#epoch === started) {
      this.#setError(result.ok ? null : result.error)
    }
    return result.ok ? result.path : null
  }

  error(): AssetSaveError | null {
    return this.#current
  }

  subscribe(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  reset(): void {
    this.#epoch += 1
    this.#setError(null)
  }

  #setError(next: AssetSaveError | null): void {
    if (next === this.#current) {
      return
    }
    this.#current = next
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/**
 * An {@link AttachmentSaveScope} over `save`.
 */
export function createAttachmentSaveScope(deps: AttachmentSaveScopeDeps): AttachmentSaveScope {
  return new AttachmentSaveScopeImpl(deps)
}

/**

 * A listing reduced to what resolution reads, for change detection.

 */
function listingKey(files: readonly Pick<FileMeta, 'path' | 'size'>[]): string {
  return files
    .map(({ path, size }) => `${path}\0${size}`)
    .toSorted()
    .join('\n')
}

interface CatalogEntry {
  readonly generation: number
  catalog: AttachmentCatalog | null
  key: string | null
  listing: Promise<AttachmentCatalog> | null
  /**
   * Sequence number of the newest listing started, and of the one stored.
   */
  started: number
  stored: number
}

export interface AttachmentServiceDeps {
  readonly assetStore: AssetStoreService
  readonly noteFile: NoteFileService
  readonly fileChanges: FileChangeService
  readonly progress: ProgressPort
  readonly clock: ClockService
  readonly platform: FileSrcSource
  readonly graphSession: GraphSessionSource
}

class AttachmentServiceImpl implements AttachmentService {
  readonly #deps: AttachmentServiceDeps
  readonly #catalogListeners = new Set<() => void>()
  #entry: CatalogEntry | null = null
  // Sizes of files saved this graph session, by generation and asset path:
  // the size is already in hand, while the catalog only lists the file once
  // the watcher reports it.
  readonly #savedSizes = new Map<number, Map<string, number>>()

  constructor(deps: AttachmentServiceDeps) {
    this.#deps = deps
  }

  peekCatalog(): AttachmentCatalog | null {
    const generation = this.#openGeneration()
    return generation === null ? null : this.#peekCatalog(generation)
  }

  async loadCatalog(): Promise<AttachmentCatalog> {
    return await this.#loadCatalog(requireGraphSession(this.#deps.graphSession).generation)
  }

  watchCatalog(generation: number): Unlisten {
    const { fileChanges } = this.#deps
    this.#loadCatalog(generation).catch(() => {})
    const stopChanges = fileChanges.subscribe(({ changes }) => {
      if (changes.some((change) => isAttachmentPath(change.path))) {
        this.#relist(generation)
      }
    })
    const stopReconcile = fileChanges.subscribeReconcile(() => {
      this.#relist(generation)
    })
    return () => {
      stopChanges()
      stopReconcile()
    }
  }

  onCatalogChanged(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#catalogListeners.add(deliver)
    return () => {
      this.#catalogListeners.delete(deliver)
    }
  }

  resolveAttachmentPath(notePath: string, destination: string): string | null {
    return this.#resolveAttachmentPath(notePath, destination, this.#openGeneration())
  }

  resolveAssetOpenPath(notePath: string, source: string): string | null {
    const generation = this.#openGeneration()
    return generation === null
      ? null
      : assetOpenPath(source, this.#resolveAttachmentPath(notePath, source, generation))
  }

  resolveImageUrl(notePath: string, source: string): MaybePromise<string | undefined> {
    return this.#resolveImageUrl(notePath, source, this.#openGeneration())
  }

  async resolvePreviewImageUrl(
    notePath: string,
    source: string,
    generation: number,
  ): Promise<string | undefined> {
    const assetPath = this.#resolveAttachmentPath(notePath, source, generation)
    // SVG can contain external subresource references. The filename check
    // avoids an unnecessary request; the query also makes the asset protocol
    // enforce a sniffed raster MIME allowlist, so renamed SVG bytes cannot
    // bypass the passive preview's no-network boundary.
    if (assetPath === null || isSvgAsset(assetPath)) {
      return
    }
    const url = await this.#resolveImageUrl(notePath, source, generation)
    return url === undefined ? undefined : previewRasterUrl(url)
  }

  resolveWikiEmbed(target: string): WikiEmbedDisplay | undefined {
    return wikiEmbedDisplay(target)
  }

  claimsFileLink(notePath: string, href: string): boolean {
    return isManagedAssetPath(href) || resolveAttachmentLink(notePath, href, null) !== null
  }

  async resolveFileInfo(notePath: string, href: string): Promise<{ size: number } | undefined> {
    const generation = this.#openGeneration()
    if (generation === null) {
      return
    }
    const savedSize = isManagedAssetPath(href)
      ? this.#savedSizes.get(generation)?.get(href)
      : undefined
    if (savedSize !== undefined) {
      return { size: savedSize }
    }
    try {
      // Waits for the first listing, so a pill rendered before the catalog
      // arrived still resolves the file (and size) it will display.
      const catalog = await this.#loadCatalog(generation)
      const assetPath = resolveAttachmentLink(notePath, href, catalog)
      const size =
        assetPath === null
          ? undefined
          : (this.#savedSizes.get(generation)?.get(assetPath) ?? catalog.size(assetPath))
      return size === undefined ? undefined : { size }
    } catch {
      // A failed listing degrades to a pill without a size.
      return
    }
  }

  async saveFile(file: File): Promise<AssetSaveResult | null> {
    const { assetStore, progress, clock } = this.#deps
    const generation = this.#openGeneration()
    if (generation === null) {
      return null
    }
    const imageExtension = EXTENSION_BY_MIME[file.type]
    // Rust owns collision suffixes, so two pastes in the same millisecond
    // land as `pasted-<ts>.png` and `pasted-<ts>-2.png`.
    const desiredName =
      imageExtension === undefined
        ? assetFileName(file.name)
        : `pasted-${clock.now()}.${imageExtension}`
    try {
      const path = await assetStore.uploadBlob(desiredName, file, generation)
      this.#recordSavedSize(generation, path, file.size)
      if (file.size > LARGE_FILE_BYTES) {
        progress
          .start('Large file added')
          .warn(
            `“${file.name}” is ${formatBytes(file.size)}. Git keeps every version forever; GitHub rejects files over 100 MB.`,
          )
      }
      return { ok: true, path }
    } catch (cause) {
      // The kind mirrors the naming decision above: an image MIME without a
      // known extension was saved as a named attachment, so its failure
      // reads as a file, not a "pasted image".
      return {
        ok: false,
        error: {
          kind: imageExtension === undefined ? 'file' : 'image',
          message: errorMessage(cause),
        },
      }
    }
  }

  createSaveScope(): AttachmentSaveScope {
    return createAttachmentSaveScope({ save: (file) => this.saveFile(file) })
  }

  async attachFilesToNote({ sources, findEditor }: AttachFilesRequest): Promise<void> {
    const { assetStore, progress } = this.#deps
    const generation = this.#openGeneration()
    if (generation === null || findEditor() === null) {
      return
    }
    const links: string[] = []
    const attachedNames: string[] = []
    const failures: { name: string; cause: unknown }[] = []
    for (const source of sources) {
      // Each copy is independent: one failure must not drop the files
      // picked after it.
      const name = basenameOf(source)
      try {
        const assetPath = await assetStore.importFile(source, assetFileName(name), generation)
        links.push(`[${escapeLinkLabel(name)}](${assetPath})`)
        attachedNames.push(name)
      } catch (cause) {
        failures.push({ name, cause })
      }
    }
    const problems: string[] = []
    if (links.length > 0) {
      // Looked up again after the awaits: the picker (and the copies) can
      // outlive the editor that was mounted when the command fired.
      const editor = findEditor()
      if (editor === null) {
        problems.push(
          `the note closed before its links could be inserted — ` +
            `${attachedNames.join(', ')} were still copied into assets/`,
        )
      } else {
        editor.insertMarkdown(links.join('\n'))
        editor.focus()
      }
    }
    if (failures.length > 0) {
      const details = failures
        .map(({ name, cause }) => `${name} (${errorMessage(cause)})`)
        .join(', ')
      problems.push(`could not be copied: ${details}`)
    }
    if (problems.length > 0) {
      progress.fail('Attaching file', problems.join('; '))
    }
  }

  async openOrReveal(path: string): Promise<void> {
    const { assetStore, progress } = this.#deps
    const generation = this.#openGeneration()
    if (generation === null) {
      return
    }
    try {
      await assetStore.open(path, generation)
    } catch (openCause) {
      // A refused file type still deserves a visible outcome: fall back to
      // the file manager. When even the reveal fails (missing or evicted
      // file), report the original open error, which matches the intent.
      try {
        await assetStore.reveal(path, generation)
        progress
          .start('Opening attachment')
          .warn('This file type can’t be opened directly, so it was revealed in Finder instead.')
      } catch {
        progress.fail('Opening attachment', errorMessage(openCause))
      }
    }
  }

  #openGeneration(): number | null {
    return this.#deps.graphSession.getState().session?.generation ?? null
  }

  #entryFor(generation: number): CatalogEntry {
    if (this.#entry?.generation !== generation) {
      this.#entry = { generation, catalog: null, key: null, listing: null, started: 0, stored: 0 }
    }
    return this.#entry
  }

  #notifyCatalogChanged(): void {
    for (const listener of this.#catalogListeners) {
      listener()
    }
  }

  #list(target: CatalogEntry): Promise<AttachmentCatalog> {
    target.started += 1
    const sequence = target.started
    const listing = this.#deps.noteFile.listAttachments(target.generation).then(
      (files) => {
        const key = listingKey(files)
        // A listing that lands after its graph session was replaced, or
        // after a newer listing, is answered but never stored.
        if (this.#entry !== target || sequence < target.stored) {
          return target.key === key && target.catalog !== null
            ? target.catalog
            : createAttachmentCatalog(files)
        }
        if (target.listing === listing) {
          target.listing = null
        }
        target.stored = sequence
        if (target.catalog !== null && target.key === key) {
          return target.catalog
        }
        const catalog = createAttachmentCatalog(files)
        target.catalog = catalog
        target.key = key
        this.#notifyCatalogChanged()
        return catalog
      },
      (error: unknown) => {
        if (target.listing === listing) {
          target.listing = null
        }
        throw error
      },
    )
    target.listing = listing
    return listing
  }

  #peekCatalog(generation: number): AttachmentCatalog | null {
    return this.#entry?.generation === generation ? this.#entry.catalog : null
  }

  async #loadCatalog(generation: number): Promise<AttachmentCatalog> {
    const target = this.#entryFor(generation)
    if (target.catalog !== null) {
      return target.catalog
    }
    return await (target.listing ?? this.#list(target))
  }

  #relist(generation: number): void {
    if (this.#entry?.generation === generation) {
      this.#list(this.#entry).catch(() => {})
    }
  }

  #resolveAttachmentPath(
    notePath: string,
    destination: string,
    generation: number | null,
  ): string | null {
    return generation === null
      ? null
      : resolveAttachmentLink(notePath, destination, this.#peekCatalog(generation))
  }

  #resolveImageUrl(
    notePath: string,
    source: string,
    generation: number | null,
  ): MaybePromise<string | undefined> {
    if (/^https?:\/\//i.test(source)) {
      return source
    }
    if (generation === null) {
      return undefined
    }
    const url = (catalog: AttachmentCatalog | null): string | undefined => {
      const path = resolveAttachmentLink(notePath, source, catalog)
      return path === null
        ? undefined
        : this.#deps.platform.convertFileSrc(`${generation}/${path}`, ASSET_PROTOCOL)
    }
    const catalog = this.#peekCatalog(generation)
    return catalog === null
      ? this.#loadCatalog(generation).then(url, () => url(null))
      : url(catalog)
  }

  #recordSavedSize(generation: number, path: string, size: number): void {
    for (const known of this.#savedSizes.keys()) {
      if (known > generation) {
        // Saved for a graph session that was already replaced.
        return
      }
      if (known < generation) {
        this.#savedSizes.delete(known)
      }
    }
    let sizes = this.#savedSizes.get(generation)
    if (sizes === undefined) {
      sizes = new Map()
      this.#savedSizes.set(generation, sizes)
    }
    sizes.set(path, size)
  }
}

export function createAttachmentService(deps: AttachmentServiceDeps): AttachmentService {
  return new AttachmentServiceImpl(deps)
}
