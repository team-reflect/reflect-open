import type { IdService } from '../ports/id-service.ts'
import { AppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import {
  createNoteCreationService,
  type NoteCreationService,
  type ResolveOrCreateNoteResult,
} from '../graph/note-creation-service.ts'
import type {
  LocalNoteRead,
  NoteFileService,
  NoteWriteResult,
  VaultScanStats,
} from '../graph/note-file-service.ts'
import {
  createNoteLinkResolverService,
  type ExistingWikiTargetResolution,
  type NoteLinkResolverService,
} from '../graph/note-link-resolver-service.ts'
import { ASSETS_DIR, AUDIO_MEMOS_DIR, isAttachmentPath, isNotePath } from '../graph/paths.ts'
import type { FileMeta, NoteCreateOutcome } from '../graph/schemas.ts'
import {
  createWikiResolverService,
  type WikiResolverService,
} from '../indexing/wiki-resolver-service.ts'
import { bytesToBase64, base64ToBytes } from '@reflect/utils'
import { createNodeTestDatabaseService } from './database.ts'
import { createTestIdService } from './id.ts'

function notFound(what: string): AppError {
  return new AppError('notFound', `${what} not found`)
}

function byteSize(contents: string): number {
  return new TextEncoder().encode(contents).length
}

/**

 * Rejects a call pinned to a generation other than `current`, like Rust does.

 */
function checkGeneration(current: number | undefined, generation: number | undefined): void {
  if (current !== undefined && generation !== undefined && generation !== current) {
    throw new AppError('io', 'the graph changed since this command was issued; dropping it')
  }
}

export interface TestNoteFileServiceOptions {
  /**
   * Graph-relative paths to file contents.
   */
  files?: Readonly<Record<string, string>>
  /**
   * When set, calls pinned to another generation reject.
   */
  generation?: number
  /**
   * Paths whose bytes are offloaded to iCloud.
   */
  evicted?: readonly string[]
}

export interface NoteFileWrite {
  path: string
  contents: string
  generation: number
}

export interface NoteFileRead {
  path: string
  generation: number | undefined
}

export interface TestNoteFileService extends NoteFileService {
  /**
   * Put a file into the graph without recording a write.
   */
  set(path: string, contents: string, options?: { modifiedMs?: number }): void
  /**
   * Mark a path as offloaded to iCloud until it is written again.
   */
  evict(path: string): void
  /**
   * Make the next `write` of `path` merge: `content` becomes the file and is
   * returned as `merged`. Without it, a checked write against a file that
   * holds neither `expectedContents` nor the new contents rejects.
   */
  mergeNextWrite(path: string, content: string): void
  /**
   * The current files by graph-relative path.
   */
  files(): ReadonlyMap<string, string>
  /**
   * Every successful `write` and `create`, in order.
   */
  writes(): readonly NoteFileWrite[]
  /**
   * The contents of every successful `write` and `create` of `path`, in order.
   */
  getWrites(path: string): readonly string[]
  /**
   * Every `read` call, in order, including the ones that rejected.
   */
  getReads(): readonly NoteFileRead[]
  /**
   * Every path moved to the trash, in order.
   */
  trashed(): readonly string[]
}

class TestNoteFileServiceImpl implements TestNoteFileService {
  readonly #files = new Map<string, { contents: string; modifiedMs: number }>()
  readonly #evicted: Set<string>
  readonly #writeLog: NoteFileWrite[] = []
  readonly #readLog: NoteFileRead[] = []
  readonly #trashLog: string[] = []
  readonly #merges = new Map<string, string>()
  readonly #generation: number | undefined
  #tick = 0

  constructor(options?: TestNoteFileServiceOptions) {
    this.#evicted = new Set<string>(options?.evicted ?? [])
    this.#generation = options?.generation
    for (const [path, contents] of Object.entries(options?.files ?? {})) {
      this.#files.set(path, { contents, modifiedMs: 0 })
    }
  }

  read(path: string, pinned: number): Promise<string> {
    return Promise.try(() => {
      this.#readLog.push({ path, generation: pinned })
      checkGeneration(this.#generation, pinned)
      return this.#contentsOf(path)
    })
  }

  readLocal(path: string, pinned: number): Promise<LocalNoteRead> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      const content = this.#contentsOf(path)
      return this.#evicted.has(path) ? { kind: 'evicted' } : { kind: 'content', content }
    })
  }

  write(
    path: string,
    contents: string,
    pinned: number,
    expectedContents?: string | null,
  ): Promise<NoteWriteResult> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      const merged = this.#merges.get(path)
      if (merged !== undefined) {
        this.#merges.delete(path)
        this.#store(path, merged, pinned)
        return { merged }
      }
      if (expectedContents !== undefined) {
        const current = this.#files.get(path)?.contents ?? null
        if (current !== expectedContents && current !== contents) {
          throw new AppError('io', 'Note changed on disk; reload before retrying')
        }
        if (current === contents) {
          return { merged: null }
        }
      }
      this.#store(path, contents, pinned)
      return { merged: null }
    })
  }

  create(path: string, contents: string, pinned: number): Promise<NoteCreateOutcome> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      if (this.#files.has(path)) {
        return { kind: 'collision' }
      }
      return { kind: 'created', modifiedMs: this.#store(path, contents, pinned) }
    })
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.#files.has(path))
  }

  delete(path: string, pinned: number): Promise<void> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      if (this.#files.delete(path)) {
        this.#evicted.delete(path)
        this.#trashLog.push(path)
      }
    })
  }

  listNotes(pinned: number): Promise<FileMeta[]> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      return this.#list(isNotePath)
    })
  }

  listAttachments(pinned: number): Promise<FileMeta[]> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      return this.#list(isAttachmentPath)
    })
  }

  listDir(dir: string, pinned: number): Promise<FileMeta[]> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      return this.#list((path) => path.startsWith(prefix))
    })
  }

  vaultScanStats(pinned: number): Promise<VaultScanStats> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      return {
        notes: this.#list(isNotePath).length,
        attachments: this.#list(isAttachmentPath).length,
        skipped: 0,
      }
    })
  }

  set(path: string, contents: string, setOptions?: { modifiedMs?: number }): void {
    this.#files.set(path, { contents, modifiedMs: setOptions?.modifiedMs ?? 0 })
  }

  evict(path: string): void {
    this.#evicted.add(path)
  }

  mergeNextWrite(path: string, content: string): void {
    this.#merges.set(path, content)
  }

  files(): ReadonlyMap<string, string> {
    return new Map([...this.#files].map(([path, file]) => [path, file.contents]))
  }

  writes(): readonly NoteFileWrite[] {
    return [...this.#writeLog]
  }

  getWrites(path: string): readonly string[] {
    return this.#writeLog.filter((write) => write.path === path).map((write) => write.contents)
  }

  getReads(): readonly NoteFileRead[] {
    return this.#readLog.map((read) => ({ ...read }))
  }

  trashed(): readonly string[] {
    return [...this.#trashLog]
  }

  #store(path: string, contents: string, pinned: number): number {
    this.#tick += 1
    this.#files.set(path, { contents, modifiedMs: this.#tick })
    this.#evicted.delete(path)
    this.#writeLog.push({ path, contents, generation: pinned })
    return this.#tick
  }

  #contentsOf(path: string): string {
    const file = this.#files.get(path)
    if (file === undefined) {
      throw notFound(path)
    }
    return file.contents
  }

  #list(include: (path: string) => boolean): FileMeta[] {
    return [...this.#files]
      .filter(([path]) => include(path))
      .map(([path, file]) => ({
        path,
        size: byteSize(file.contents),
        modifiedMs: file.modifiedMs,
        ...(this.#evicted.has(path) ? { placeholder: true } : {}),
      }))
  }
}

/**
 * An in-memory {@link NoteFileService}. Writes stamp `modifiedMs` from a
 * counter, so the n-th write in a test reports `n`; seeded files report 0.
 */
export function createTestNoteFileService(
  options?: TestNoteFileServiceOptions,
): TestNoteFileService {
  return new TestNoteFileServiceImpl(options)
}

/**
 * A {@link NoteFileService} that forwards each member to `inner`, except the
 * ones `overrides` replaces. The inner service keeps its own behavior.
 */
class NoteFileOverrideService implements NoteFileService {
  readonly #inner: NoteFileService
  readonly #overrides: Partial<NoteFileService>

  constructor(inner: NoteFileService, overrides: Partial<NoteFileService>) {
    this.#inner = inner
    this.#overrides = overrides
  }

  read(path: string, generation: number): Promise<string> {
    return (this.#overrides.read ?? this.#inner.read.bind(this.#inner))(path, generation)
  }

  readLocal(path: string, generation: number): Promise<LocalNoteRead> {
    return (this.#overrides.readLocal ?? this.#inner.readLocal.bind(this.#inner))(path, generation)
  }

  write(
    path: string,
    contents: string,
    generation: number,
    expectedContents?: string | null,
  ): Promise<NoteWriteResult> {
    return (this.#overrides.write ?? this.#inner.write.bind(this.#inner))(
      path,
      contents,
      generation,
      expectedContents,
    )
  }

  create(path: string, contents: string, generation: number): Promise<NoteCreateOutcome> {
    return (this.#overrides.create ?? this.#inner.create.bind(this.#inner))(
      path,
      contents,
      generation,
    )
  }

  exists(path: string): Promise<boolean> {
    return (this.#overrides.exists ?? this.#inner.exists.bind(this.#inner))(path)
  }

  delete(path: string, generation: number): Promise<void> {
    return (this.#overrides.delete ?? this.#inner.delete.bind(this.#inner))(path, generation)
  }

  listNotes(generation: number): Promise<FileMeta[]> {
    return (this.#overrides.listNotes ?? this.#inner.listNotes.bind(this.#inner))(generation)
  }

  listAttachments(generation: number): Promise<FileMeta[]> {
    return (this.#overrides.listAttachments ?? this.#inner.listAttachments.bind(this.#inner))(
      generation,
    )
  }

  listDir(dir: string, generation: number): Promise<FileMeta[]> {
    return (this.#overrides.listDir ?? this.#inner.listDir.bind(this.#inner))(dir, generation)
  }

  vaultScanStats(generation: number): Promise<VaultScanStats> {
    return (this.#overrides.vaultScanStats ?? this.#inner.vaultScanStats.bind(this.#inner))(
      generation,
    )
  }
}

/**
 * `inner` with some members replaced. Use it instead of spreading a note file
 * service, which would drop its prototype methods.
 */
export function overrideNoteFileService(
  inner: NoteFileService,
  overrides: Partial<NoteFileService>,
): NoteFileService {
  return new NoteFileOverrideService(inner, overrides)
}

type Bytes = string | Uint8Array

function toBytes(contents: Bytes): Uint8Array<ArrayBuffer> {
  if (typeof contents === 'string') {
    return new TextEncoder().encode(contents)
  }
  const copy = new Uint8Array(contents.byteLength)
  copy.set(contents)
  return copy
}

export interface TestAssetStoreServiceOptions {
  /**
   * Graph-relative paths to file bytes; strings are stored UTF-8 encoded.
   */
  assets?: Readonly<Record<string, Bytes>>
  /**
   * OS paths that `importFile` and `importAudioMemo` can copy from.
   */
  sources?: Readonly<Record<string, Bytes>>
  /**
   * Transcript cache entries by name.
   */
  transcripts?: Readonly<Record<string, string>>
  /**
   * When set, calls pinned to another generation reject.
   */
  generation?: number
}

export interface AssetUpload {
  kind: 'blob' | 'path' | 'import' | 'base64' | 'audio-memo'
  path: string
  generation: number
}

export interface TestAssetStoreService extends AssetStoreService {
  /**
   * The current files by graph-relative path.
   */
  assets(): ReadonlyMap<string, Uint8Array>
  /**
   * Every successful write, in order.
   */
  uploads(): readonly AssetUpload[]
  /**
   * The transcript cache by name.
   */
  transcripts(): ReadonlyMap<string, string>
  /**
   * Every path passed to `open`, in order.
   */
  opened(): readonly string[]
  /**
   * Every path passed to `reveal`, in order.
   */
  revealed(): readonly string[]
}

class TestAssetStoreServiceImpl implements TestAssetStoreService {
  readonly #files = new Map<string, Uint8Array<ArrayBuffer>>()
  readonly #sources = new Map<string, Uint8Array<ArrayBuffer>>()
  readonly #transcripts: Map<string, string>
  readonly #uploadLog: AssetUpload[] = []
  readonly #openLog: string[] = []
  readonly #revealLog: string[] = []
  readonly #generation: number | undefined

  constructor(options?: TestAssetStoreServiceOptions) {
    this.#transcripts = new Map<string, string>(Object.entries(options?.transcripts ?? {}))
    this.#generation = options?.generation
    for (const [path, contents] of Object.entries(options?.assets ?? {})) {
      this.#files.set(path, toBytes(contents))
    }
    for (const [path, contents] of Object.entries(options?.sources ?? {})) {
      this.#sources.set(path, toBytes(contents))
    }
  }

  async uploadBlob(desiredName: string, contents: Blob, pinned: number): Promise<string> {
    checkGeneration(this.#generation, pinned)
    const path = this.#freePath(desiredName)
    this.#store('blob', path, await blobBytes(contents), pinned)
    return path
  }

  async uploadToPath(path: string, contents: Blob, pinned: number): Promise<void> {
    checkGeneration(this.#generation, pinned)
    this.#store('path', path, await blobBytes(contents), pinned)
  }

  importFile(sourcePath: string, desiredName: string, pinned: number): Promise<string> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      const bytes = this.#bytesOf(sourcePath, this.#sources)
      const path = this.#freePath(desiredName)
      this.#store('import', path, bytes, pinned)
      return path
    })
  }

  writeBase64(path: string, contentsBase64: string, pinned: number): Promise<void> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      this.#store('base64', path, base64ToBytes(contentsBase64), pinned)
    })
  }

  readBase64(path: string, pinned: number): Promise<string> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      return bytesToBase64(this.#bytesOf(path, this.#files))
    })
  }

  readBytes(path: string, pinned: number): Promise<Uint8Array<ArrayBuffer>> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      return toBytes(this.#bytesOf(path, this.#files))
    })
  }

  open(path: string, pinned: number): Promise<void> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      this.#openLog.push(path)
    })
  }

  reveal(path: string, pinned: number): Promise<void> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      this.#revealLog.push(path)
    })
  }

  deleteAudioMemo(path: string, pinned: number): Promise<void> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      if (!path.startsWith(`${AUDIO_MEMOS_DIR}/`)) {
        throw new AppError('io', `not an audio memo: ${path}`)
      }
      this.#files.delete(path)
    })
  }

  importAudioMemo(sourcePath: string, path: string, pinned: number): Promise<void> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      if (this.#files.has(path)) {
        return
      }
      this.#store('audio-memo', path, this.#bytesOf(sourcePath, this.#sources), pinned)
    })
  }

  readTranscriptCache(name: string, pinned: number): Promise<string> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      const contents = this.#transcripts.get(name)
      if (contents === undefined) {
        throw notFound(name)
      }
      return contents
    })
  }

  writeTranscriptCache(name: string, contents: string, pinned: number): Promise<void> {
    return Promise.try(() => {
      checkGeneration(this.#generation, pinned)
      this.#transcripts.set(name, contents)
    })
  }

  assets(): ReadonlyMap<string, Uint8Array> {
    return new Map(this.#files)
  }

  uploads(): readonly AssetUpload[] {
    return [...this.#uploadLog]
  }

  transcripts(): ReadonlyMap<string, string> {
    return new Map(this.#transcripts)
  }

  opened(): readonly string[] {
    return [...this.#openLog]
  }

  revealed(): readonly string[] {
    return [...this.#revealLog]
  }

  #freePath(desiredName: string): string {
    const dot = desiredName.lastIndexOf('.')
    const stem = dot > 0 ? desiredName.slice(0, dot) : desiredName
    const extension = dot > 0 ? desiredName.slice(dot) : ''
    let path = `${ASSETS_DIR}/${desiredName}`
    for (let suffix = 2; this.#files.has(path); suffix++) {
      path = `${ASSETS_DIR}/${stem}-${suffix}${extension}`
    }
    return path
  }

  #store(
    kind: AssetUpload['kind'],
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    pinned: number,
  ): void {
    this.#files.set(path, bytes)
    this.#uploadLog.push({ kind, path, generation: pinned })
  }

  #bytesOf(path: string, from: ReadonlyMap<string, Uint8Array<ArrayBuffer>>) {
    const bytes = from.get(path)
    if (bytes === undefined) {
      throw notFound(path)
    }
    return bytes
  }
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * An in-memory {@link AssetStoreService}. `uploadBlob` and `importFile` pick
 * `assets/<name>`, or the first free `-2`-suffixed variant.
 */
export function createTestAssetStoreService(
  options?: TestAssetStoreServiceOptions,
): TestAssetStoreService {
  return new TestAssetStoreServiceImpl(options)
}

export interface TestNoteLinkResolverServiceOptions {
  /**
   * The index the resolver's tiers read; defaults to one over an empty Node.js test database.
   */
  wikiResolver?: WikiResolverService
  /**
   * The files the resolver probes; defaults to an empty test note file service.
   */
  noteFile?: NoteFileService
}

/**

 * One call to a {@link TestNoteLinkResolverService}, with its result.

 */
export type NoteLinkResolution =
  | {
      readonly kind: 'wiki'
      readonly target: string
      readonly generation: number
      readonly sourcePath: string | undefined
      readonly result: ExistingWikiTargetResolution
    }
  | {
      readonly kind: 'markdown'
      readonly sourcePath: string
      readonly href: string
      readonly generation: number
      readonly result: ExistingWikiTargetResolution
    }

export interface TestNoteLinkResolverService extends NoteLinkResolverService {
  /**
   * Every settled resolution, in order.
   */
  calls(): readonly NoteLinkResolution[]
}

/**
 * Forwards every member to the real service and records each resolution.
 */
class TestNoteLinkResolverServiceImpl implements TestNoteLinkResolverService {
  readonly #inner: NoteLinkResolverService
  readonly #log: NoteLinkResolution[] = []

  constructor(inner: NoteLinkResolverService) {
    this.#inner = inner
  }

  async resolveWikiTarget(
    target: string,
    generation: number,
    sourcePath?: string,
  ): Promise<ExistingWikiTargetResolution> {
    const result = await this.#inner.resolveWikiTarget(target, generation, sourcePath)
    this.#log.push({ kind: 'wiki', target, generation, sourcePath, result })
    return result
  }

  async resolveMarkdownHref(
    sourcePath: string,
    href: string,
    generation: number,
  ): Promise<ExistingWikiTargetResolution> {
    const result = await this.#inner.resolveMarkdownHref(sourcePath, href, generation)
    this.#log.push({ kind: 'markdown', sourcePath, href, generation, result })
    return result
  }

  calls(): readonly NoteLinkResolution[] {
    return [...this.#log]
  }
}

/**
 * The real {@link NoteLinkResolverService} over test doubles, recording each resolution.
 */
export function createTestNoteLinkResolverService(
  options?: TestNoteLinkResolverServiceOptions,
): TestNoteLinkResolverService {
  return new TestNoteLinkResolverServiceImpl(
    createNoteLinkResolverService({
      wikiResolver:
        options?.wikiResolver ??
        createWikiResolverService({ database: createNodeTestDatabaseService() }),
      noteFile: options?.noteFile ?? createTestNoteFileService(),
    }),
  )
}

export interface TestNoteCreationServiceOptions {
  /**
   * Where notes are created; defaults to an empty test note file service.
   */
  noteFile?: NoteFileService
  /**
   * Defaults to a {@link createTestNoteLinkResolverService} over `noteFile`.
   */
  noteLinkResolver?: NoteLinkResolverService
  /**
   * Defaults to {@link createTestIdService}.
   */
  id?: IdService
}

export interface TestNoteCreationService extends NoteCreationService {
  /**
   * Every path `createNoteWithTitle` or `resolveOrCreateNoteWithTitle` created, in order.
   */
  created(): readonly string[]
}

/**
 * Forwards every member to the real service and records each created path.
 */
class TestNoteCreationServiceImpl implements TestNoteCreationService {
  readonly #inner: NoteCreationService
  readonly #createdLog: string[] = []

  constructor(inner: NoteCreationService) {
    this.#inner = inner
  }

  newNoteId(): string {
    return this.#inner.newNoteId()
  }

  untitledNoteSeed(): string {
    return this.#inner.untitledNoteSeed()
  }

  untitledNotePath(): string {
    return this.#inner.untitledNotePath()
  }

  async createNoteWithTitle(title: string, generation: number, body?: string): Promise<string> {
    const path = await this.#inner.createNoteWithTitle(title, generation, body)
    this.#createdLog.push(path)
    return path
  }

  async resolveOrCreateNoteWithTitle(
    title: string,
    generation: number,
    body?: string,
  ): Promise<ResolveOrCreateNoteResult> {
    const result = await this.#inner.resolveOrCreateNoteWithTitle(title, generation, body)
    if (result.kind === 'created') {
      this.#createdLog.push(result.path)
    }
    return result
  }

  created(): readonly string[] {
    return [...this.#createdLog]
  }
}

/**
 * The real {@link NoteCreationService} over test doubles, recording each created path.
 */
export function createTestNoteCreationService(
  options?: TestNoteCreationServiceOptions,
): TestNoteCreationService {
  const noteFile = options?.noteFile ?? createTestNoteFileService()
  return new TestNoteCreationServiceImpl(
    createNoteCreationService({
      noteFile,
      noteLinkResolver:
        options?.noteLinkResolver ?? createTestNoteLinkResolverService({ noteFile }),
      id: options?.id ?? createTestIdService(),
    }),
  )
}
