import type { XPost } from '@post-embed/types'
import type { LinkPreviewHtml, WebFetchService } from '../link-preview/web-fetch-service.ts'
import type { CloudSafe } from '../privacy/cloud-safe.ts'
import type {
  CaptureService,
  CaptureSession,
  CaptureSessionOptions,
} from '../capture/capture-service.ts'
import { AppError } from '../errors.ts'
import type { CaptureInboxService } from '../graph/capture-inbox-service.ts'
import type { FileMeta } from '../graph/schemas.ts'
import type { Unlisten } from '../unlisten.ts'
import type {
  ArchivedXPost,
  ResolvedArchivedPost,
  XArchiveService,
} from '../embeds/x-archive-service.ts'

const INBOX_DIR = '.reflect/inbox'

function notFound(what: string): AppError {
  return new AppError('notFound', `${what} not found`)
}

function encodeContents(contents: unknown): string {
  return typeof contents === 'string' ? contents : JSON.stringify(contents)
}

export interface TestCaptureInboxService extends CaptureInboxService {
  /**
   * Put a file into the inbox. Non-string contents are stored as JSON.
   */
  add(name: string, contents: unknown, options?: { modifiedMs?: number }): void
  /**
   * The inbox files by spool filename.
   */
  files(): ReadonlyMap<string, string>
  spooled(): readonly { name: string; json: string; generation: number }[]
  removed(): readonly string[]
  rejected(): readonly string[]
  hostRegistrations(): number
}

/**
 * An in-memory {@link CaptureInboxService}. `envelopes` and `shared` map
 * spool filenames to file contents; non-string contents are stored as JSON.
 * {@link CaptureInboxService.relaySharedInbox} moves the `shared` files into the inbox.
 */
class TestCaptureInboxServiceImpl implements TestCaptureInboxService {
  readonly #inbox = new Map<string, { contents: string; modifiedMs: number }>()
  readonly #shared = new Map<string, string>()
  readonly #spoolLog: { name: string; json: string; generation: number }[] = []
  readonly #removeLog: string[] = []
  readonly #rejectLog: string[] = []
  #registrations = 0

  constructor(options?: {
    envelopes?: Readonly<Record<string, unknown>>
    shared?: Readonly<Record<string, unknown>>
  }) {
    for (const [name, contents] of Object.entries(options?.envelopes ?? {})) {
      this.add(name, contents)
    }
    for (const [name, contents] of Object.entries(options?.shared ?? {})) {
      this.#shared.set(name, encodeContents(contents))
    }
  }

  registerHost(): Promise<void> {
    this.#registrations += 1
    return Promise.resolve()
  }

  list(): Promise<FileMeta[]> {
    return Promise.resolve(
      [...this.#inbox].map(([name, entry]) => ({
        path: `${INBOX_DIR}/${name}`,
        size: entry.contents.length,
        modifiedMs: entry.modifiedMs,
      })),
    )
  }

  read(name: string): Promise<string> {
    const entry = this.#inbox.get(name)
    if (entry === undefined) {
      return Promise.reject(notFound(`${INBOX_DIR}/${name}`))
    }
    return Promise.resolve(entry.contents)
  }

  spool(name: string, json: string, generation: number): Promise<void> {
    return Promise.try(() => {
      this.#spoolLog.push({ name, json, generation })
      this.add(name, json)
    })
  }

  remove(name: string): Promise<void> {
    this.#removeLog.push(name)
    this.#inbox.delete(name)
    return Promise.resolve()
  }

  reject(name: string): Promise<void> {
    this.#rejectLog.push(name)
    this.#inbox.delete(name)
    return Promise.resolve()
  }

  relaySharedInbox(): Promise<number> {
    return Promise.try(() => {
      const moved = this.#shared.size
      for (const [name, contents] of this.#shared) {
        this.add(name, contents)
      }
      this.#shared.clear()
      return moved
    })
  }

  promoteScreenshot(spoolName: string): Promise<void> {
    if (!this.#inbox.has(spoolName)) {
      return Promise.reject(notFound(`${INBOX_DIR}/${spoolName}`))
    }
    return Promise.resolve()
  }

  add(name: string, contents: unknown, options?: { modifiedMs?: number }): void {
    this.#inbox.set(name, {
      contents: encodeContents(contents),
      modifiedMs: options?.modifiedMs ?? 0,
    })
  }

  files(): ReadonlyMap<string, string> {
    return new Map([...this.#inbox].map(([name, entry]) => [name, entry.contents]))
  }

  spooled(): readonly { name: string; json: string; generation: number }[] {
    return [...this.#spoolLog]
  }

  removed(): readonly string[] {
    return [...this.#removeLog]
  }

  rejected(): readonly string[] {
    return [...this.#rejectLog]
  }

  hostRegistrations(): number {
    return this.#registrations
  }
}

export function createTestCaptureInboxService(options?: {
  envelopes?: Readonly<Record<string, unknown>>
  shared?: Readonly<Record<string, unknown>>
}): TestCaptureInboxService {
  return new TestCaptureInboxServiceImpl(options)
}

export type WebFetchKind = 'meta' | 'oembed' | 'image' | 'html' | 'icon'

export interface TestWebFetchService extends WebFetchService {
  requests(): readonly { kind: WebFetchKind; url: string }[]
}

/**
 * A {@link WebFetchService} that answers from per-URL tables. `html` answers
 * {@link WebFetchService.fetchMeta} and, with the URL as `finalUrl`,
 * {@link WebFetchService.fetchLinkPreviewHtml}. A URL missing from its table
 * rejects with a `notFound` error, except for `image`, which answers `null`.
 */
class TestWebFetchServiceImpl implements TestWebFetchService {
  readonly #options:
    | {
        html?: Readonly<Record<string, string>>
        oembed?: Readonly<Record<string, string>>
        icon?: Readonly<Record<string, string>>
        image?: Readonly<Record<string, string>>
      }
    | undefined
  readonly #log: { kind: WebFetchKind; url: string }[] = []

  constructor(options?: {
    html?: Readonly<Record<string, string>>
    oembed?: Readonly<Record<string, string>>
    icon?: Readonly<Record<string, string>>
    image?: Readonly<Record<string, string>>
  }) {
    this.#options = options
  }

  fetchMeta(url: CloudSafe<string>): Promise<string> {
    return Promise.try(() => this.#answer('meta', this.#options?.html, url))
  }

  fetchOembed(url: CloudSafe<string>): Promise<string> {
    return Promise.try(() => this.#answer('oembed', this.#options?.oembed, url))
  }

  fetchLinkPreviewImage(url: CloudSafe<string>): string | null {
    this.#log.push({ kind: 'image', url })
    return this.#options?.image?.[url] ?? null
  }

  fetchLinkPreviewHtml(url: CloudSafe<string>): Promise<LinkPreviewHtml> {
    return Promise.try(() => ({
      html: this.#answer('html', this.#options?.html, url),
      finalUrl: url,
    }))
  }

  fetchLinkPreviewIcon(url: CloudSafe<string>): Promise<string> {
    return Promise.try(() => this.#answer('icon', this.#options?.icon, url))
  }

  requests(): readonly { kind: WebFetchKind; url: string }[] {
    return [...this.#log]
  }

  #answer(
    kind: WebFetchKind,
    table: Readonly<Record<string, string>> | undefined,
    url: string,
  ): string {
    this.#log.push({ kind, url })
    const value = table?.[url]
    if (value === undefined) {
      throw notFound(`test ${kind} for ${url}`)
    }
    return value
  }
}

export function createTestWebFetchService(options?: {
  html?: Readonly<Record<string, string>>
  oembed?: Readonly<Record<string, string>>
  icon?: Readonly<Record<string, string>>
  image?: Readonly<Record<string, string>>
}): TestWebFetchService {
  return new TestWebFetchServiceImpl(options)
}

export interface TestXArchiveService extends XArchiveService {
  /**
   * Archive `post` under `postId`, or drop the archive with `null`.
   */
  setPost(postId: string, post: ResolvedArchivedPost | null): void
  /**
   * What the syndication API answers for `postId`.
   */
  setSyndication(postId: string, post: XPost | null): void
  resolves(): readonly { generation: number; postId: string }[]
  writes(): readonly { generation: number; post: ArchivedXPost }[]
  syndicationRequests(): readonly string[]
}

/**
 * An in-memory {@link XArchiveService}. `posts` are the archived posts by id;
 * {@link XArchiveService.write} archives a post with no resources. `owners`
 * maps an asset path to its archive files. Every graph generation shares
 * one archive.
 */
class TestXArchiveServiceImpl implements TestXArchiveService {
  readonly #owners: Readonly<Record<string, readonly string[]>> | undefined
  readonly #posts: Map<string, ResolvedArchivedPost>
  readonly #syndication: Map<string, XPost>
  readonly #resolveLog: { generation: number; postId: string }[] = []
  readonly #writeLog: { generation: number; post: ArchivedXPost }[] = []
  readonly #syndicationLog: string[] = []

  constructor(options?: {
    posts?: Readonly<Record<string, ResolvedArchivedPost>>
    syndication?: Readonly<Record<string, XPost>>
    owners?: Readonly<Record<string, readonly string[]>>
  }) {
    this.#owners = options?.owners
    this.#posts = new Map(Object.entries(options?.posts ?? {}))
    this.#syndication = new Map(Object.entries(options?.syndication ?? {}))
  }

  resolve(generation: number, postId: string): Promise<ResolvedArchivedPost | null> {
    return Promise.try(() => {
      this.#resolveLog.push({ generation, postId })
      return structuredClone(this.#posts.get(postId) ?? null)
    })
  }

  owners(assetPath: string): Promise<string[]> {
    return Promise.resolve([...(this.#owners?.[assetPath] ?? [])])
  }

  write(generation: number, post: ArchivedXPost): Promise<void> {
    return Promise.try(() => {
      this.#writeLog.push({ generation, post })
      this.#posts.set(post.data.id, { archive: { ...structuredClone(post) }, resources: [] })
    })
  }

  fetchSyndication(postId: string): Promise<XPost | null> {
    return Promise.try(() => {
      this.#syndicationLog.push(postId)
      return structuredClone(this.#syndication.get(postId) ?? null)
    })
  }

  setPost(postId: string, post: ResolvedArchivedPost | null): void {
    if (post === null) {
      this.#posts.delete(postId)
    } else {
      this.#posts.set(postId, post)
    }
  }

  setSyndication(postId: string, post: XPost | null): void {
    if (post === null) {
      this.#syndication.delete(postId)
    } else {
      this.#syndication.set(postId, post)
    }
  }

  resolves(): readonly { generation: number; postId: string }[] {
    return [...this.#resolveLog]
  }

  writes(): readonly { generation: number; post: ArchivedXPost }[] {
    return [...this.#writeLog]
  }

  syndicationRequests(): readonly string[] {
    return [...this.#syndicationLog]
  }
}

export function createTestXArchiveService(options?: {
  posts?: Readonly<Record<string, ResolvedArchivedPost>>
  syndication?: Readonly<Record<string, XPost>>
  owners?: Readonly<Record<string, readonly string[]>>
}): TestXArchiveService {
  return new TestXArchiveServiceImpl(options)
}

/**
 * What happened to one session a {@link TestCaptureService} opened.
 */
export interface TestCaptureSessionState {
  generation: number
  /**
   * How many times `start()` ran.
   */
  starts: number
  /**
   * How many times `schedule()` ran.
   */
  schedules: number
  disposed: boolean
}

export interface TestCaptureService extends CaptureService {
  /**
   * Every session opened, in order.
   */
  sessions(): readonly TestCaptureSessionState[]
  /**
   * Notify every `onXPostsWritten` listener.
   */
  emitXPostsWritten(): void
}

class TestCaptureSessionImpl implements CaptureSession {
  readonly #state: TestCaptureSessionState

  constructor(state: TestCaptureSessionState) {
    this.#state = state
  }

  start(): void {
    this.#state.starts += 1
  }

  schedule(): void {
    this.#state.schedules += 1
  }

  dispose(): void {
    this.#state.disposed = true
  }
}

/**
 * A {@link CaptureService} whose sessions only record their calls: no pass ever runs.
 */
class TestCaptureServiceImpl implements TestCaptureService {
  readonly #states: TestCaptureSessionState[] = []
  readonly #listeners = new Set<() => void>()

  openSession({ generation }: CaptureSessionOptions): CaptureSession {
    const state: TestCaptureSessionState = {
      generation,
      starts: 0,
      schedules: 0,
      disposed: false,
    }
    this.#states.push(state)
    return new TestCaptureSessionImpl(state)
  }

  onXPostsWritten(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  sessions(): readonly TestCaptureSessionState[] {
    return this.#states.map((state) => ({ ...state }))
  }

  emitXPostsWritten(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createTestCaptureService(): TestCaptureService {
  return new TestCaptureServiceImpl()
}
