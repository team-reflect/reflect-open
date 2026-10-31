import type { GraphSessionSource } from '../graph/graph-session.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import type { NoteRowService } from '../documents/note-row-service.ts'
import { errorMessage, AppError } from '../errors.ts'
import { parseNote } from '../markdown/extract.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { gistBodyHash, gistFilename } from '../markdown/gist.ts'
import type { GistFrontmatter } from '../markdown/model.ts'
import type { PrivacyService } from '../privacy/privacy-service.ts'
import type { GistService } from './gist-service.ts'
import type { GithubAuthService } from './github-auth-service.ts'

/**
 * What a gist action left on the note's index row: the fields the action
 * also recorded in the optimistic row overlay.
 */
export interface GistPublishResult {
  /**
   * The gist page url; `null` after an unpublish.
   */
  readonly url: string | null
  /**
   * Whether the published body lags the note. Fresh after either action.
   */
  readonly stale: boolean
}

/**
 * Publishing a note as a secret GitHub gist, and taking it down again.
 */
export interface GistPublishService {
  /**
   * The publish action as every entry point runs it (Note actions button,
   * ⌘K command): publish and surface progress through the operations status
   * line. Resolves the row fields (the gist url) whenever the publish itself
   * landed, or `null` when the publish failed (already surfaced), another
   * gist action on the note is in flight, or no graph is open.
   *
   * On success it records the url in the optimistic note-row overlay, so every
   * sidebar surface (the gist action's label, the Published URL section)
   * reflects the publish immediately, before the watcher re-indexes the file.
   */
  publish(path: string): Promise<GistPublishResult | null>
  /**
   * The unpublish action as the sidebar runs it: delete the remote gist, clear
   * the local gist metadata, and hide the published URL optimistically while
   * the index catches up. Resolves `null` when it failed (already surfaced),
   * another gist action on the note is in flight, or no graph is open.
   */
  unpublish(path: string): Promise<GistPublishResult | null>
}

export interface GistPublishServiceDeps {
  readonly gists: GistService
  readonly githubAuth: GithubAuthService
  readonly noteDocuments: NoteDocumentService
  readonly noteRows: NoteRowService
  readonly privacy: PrivacyService
  readonly progress: ProgressPort
  readonly graphSession: GraphSessionSource
}

class GistPublishServiceImpl implements GistPublishService {
  readonly #deps: GistPublishServiceDeps
  readonly #active = new Set<string>()

  constructor(deps: GistPublishServiceDeps) {
    this.#deps = deps
  }

  async publish(path: string): Promise<GistPublishResult | null> {
    const { noteRows, progress, graphSession } = this.#deps
    const session = graphSession.getState().session
    if (session === null || !this.#claim(path)) {
      return null
    }
    const { generation } = session
    try {
      const operation = progress.start('Publishing gist')
      let url: string
      try {
        url = await this.#publishNote(path, generation)
      } catch (cause) {
        operation.fail(errorMessage(cause))
        return null
      }
      operation.done()
      // Stamp the optimism with the publishing graph's generation, so a publish
      // that resolves after a graph switch can't surface on the new graph.
      const result = { url, stale: false }
      noteRows.setOverlay(path, generation, { gistUrl: result.url, gistStale: result.stale })
      return result
    } finally {
      this.#active.delete(path)
    }
  }

  async unpublish(path: string): Promise<GistPublishResult | null> {
    const { noteRows, progress, graphSession } = this.#deps
    const session = graphSession.getState().session
    if (session === null || !this.#claim(path)) {
      return null
    }
    const { generation } = session
    try {
      const operation = progress.start('Unpublishing gist')
      try {
        await this.#unpublishNote(path, generation)
      } catch (cause) {
        operation.fail(errorMessage(cause))
        return null
      }
      operation.done()
      const result = { url: null, stale: false }
      noteRows.setOverlay(path, generation, { gistUrl: result.url, gistStale: result.stale })
      return result
    } finally {
      this.#active.delete(path)
    }
  }

  #claim(path: string): boolean {
    if (this.#active.has(path)) {
      this.#deps.progress.fail(
        'Gist operation already running',
        'Wait for the current gist operation to finish',
      )
      return false
    }
    this.#active.add(path)
    return true
  }

  /**
   * Publish a note's body to a GitHub Gist (always secret), recording the gist
   * in the note's `gist` frontmatter block, and return the gist url. A note
   * that already carries the block republishes to the **same** gist,
   * addressing the file by the name it was last published under, so a title
   * change renames instead of adding a second file. A gist deleted on
   * github.com falls back to creating a fresh one. The stored hash is of the
   * body as published, so the indexer's `gist_stale` reflects real edits,
   * never the frontmatter write itself.
   *
   * Reads and writes through `NoteDocumentService`, exactly like the
   * pin/private toggles: a direct disk write under a dirty buffer would park
   * a conflict caused by our own action, and a still-loading session is read
   * from disk rather than from its empty placeholder buffer.
   *
   * `private: true` is the hard block: the gate runs on the content actually
   * being published (live, not the possibly-lagging index), and it fails
   * closed before any byte leaves the device.
   */
  async #publishNote(path: string, generation: number): Promise<string> {
    const { gists, githubAuth, noteDocuments, privacy } = this.#deps
    const source = await noteDocuments.readSource(path)
    const parsed = parseNote({ path, source })
    privacy.assertCloudAllowed({ path, isPrivate: parsed.frontmatter.private })

    // The gist must be recorded in frontmatter or the next publish forks a new
    // one — and `upsertFrontmatter` rightly refuses to rewrite a header it
    // can't parse. That refusal must come *before* the gist exists, not after.
    if (parsed.frontmatterWarning !== undefined) {
      throw new AppError('parse', 'The note has invalid frontmatter — fix it before publishing')
    }

    const body = splitFrontmatter(source).body
    if (body.trim() === '') {
      throw new AppError('io', 'The note is empty — nothing to publish')
    }

    const token = await githubAuth.getToken()
    if (token === null) {
      throw new AppError('auth', 'Connect GitHub in Settings to publish gists')
    }

    const filename = gistFilename(parsed.title)
    const previous = parsed.frontmatter.gist
    const published =
      (previous !== undefined
        ? await gists.update(token, previous.id, previous.file, { name: filename, content: body })
        : null) ?? (await gists.create(token, { name: filename, content: body }))

    const gist: GistFrontmatter = {
      id: published.id,
      url: published.htmlUrl,
      file: filename,
      hash: gistBodyHash(body),
    }
    try {
      await noteDocuments.commitFrontmatter(path, { gist }, generation)
    } catch (cause) {
      // The remote and local halves can't be atomic; compensate instead. A
      // *freshly created* gist with no local record would be orphaned (and
      // re-created on the next publish), so best-effort delete it. A failed
      // *republish* record keeps the old block — same gist next time — and the
      // existing gist must never be deleted out from under its shared link.
      if (previous === undefined || published.id !== previous.id) {
        try {
          await gists.delete(token, published.id)
        } catch {
          // Best effort — the publish failure below is the error that matters.
        }
      }
      throw cause
    }
    return published.htmlUrl
  }

  /**
   * Delete the note's published GitHub Gist and remove the local `gist`
   * frontmatter block. A missing local block is already unpublished, so this
   * is a no-op. The local record is cleared before the remote delete, so a
   * local write failure cannot leave Reflect pointing at a dead link. If
   * GitHub rejects the delete, the local block is restored before the error
   * is surfaced.
   */
  async #unpublishNote(path: string, generation: number): Promise<void> {
    const { gists, githubAuth, noteDocuments } = this.#deps
    const source = await noteDocuments.readSource(path)
    const parsed = parseNote({ path, source })
    if (parsed.frontmatterWarning !== undefined) {
      throw new AppError('parse', 'The note has invalid frontmatter — fix it before unpublishing')
    }

    const previous = parsed.frontmatter.gist
    if (previous === undefined) {
      return
    }

    const token = await githubAuth.getToken()
    if (token === null) {
      throw new AppError('auth', 'Connect GitHub in Settings to unpublish gists')
    }

    await noteDocuments.commitFrontmatter(path, { gist: false }, generation)
    try {
      await gists.delete(token, previous.id)
    } catch (cause) {
      await noteDocuments.commitFrontmatter(path, { gist: previous }, generation)
      throw cause
    }
  }
}

export function createGistPublishService(deps: GistPublishServiceDeps): GistPublishService {
  return new GistPublishServiceImpl(deps)
}
