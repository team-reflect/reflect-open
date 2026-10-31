import { splitFrontmatter, type OpenDocumentsService } from '@reflect/core'

/**
 * What a note hands to the OS share sheet.
 */
export interface NoteShareContent {
  /**
   * The subject, for targets that use one (Mail).
   */
  title: string
  text: string
}

/**
 * The basename without its `.md` — the note's working title (Plan 17).
 */
function noteTitle(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}

/**
 * The share content of the note at `path` holding `markdown`: the markdown
 * **body** (frontmatter stripped, so the recipient never sees the `id:`
 * block), with the title (the readable filename) as the subject.
 */
export function noteShareContent(markdown: string, path: string): NoteShareContent {
  return { title: noteTitle(path), text: splitFrontmatter(markdown).body.trimStart() }
}

/**
 * What the app shares of a note through the OS share sheet (Plan 19, V1 parity).
 */
export interface ShareService {
  /**
   * The share content of the note at `path`, read **synchronously** from the
   * open editor session's live buffer. A Web Share call needs the tap's
   * transient user activation, which any `await` before the call consumes.
   * The live buffer is the only synchronous source, and it holds the user's
   * latest typing. `liveContent()` answers that buffer once the session is
   * ready (authoritative even when empty), or `null` while it's still
   * loading: then the content is empty rather than an async disk read.
   */
  noteContent(path: string): NoteShareContent
}

export interface ShareServiceDeps {
  readonly openDocuments: OpenDocumentsService
}

class ShareServiceImpl implements ShareService {
  readonly #deps: ShareServiceDeps

  constructor(deps: ShareServiceDeps) {
    this.#deps = deps
  }

  noteContent(path: string): NoteShareContent {
    return noteShareContent(this.#deps.openDocuments.sessionFor(path)?.liveContent() ?? '', path)
  }
}

export function createShareService(deps: ShareServiceDeps): ShareService {
  return new ShareServiceImpl(deps)
}
