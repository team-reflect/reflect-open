import type { MaybePromise } from '@reflect/utils'
import type { FileChange, FileChangeService } from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { NoteSession } from './note-session-types.ts'

export interface OpenDocument {
  session: NoteSession
  /**
   * Fire pending settle-time work (title renames) now.
   */
  settle?: (() => void) | undefined
  /**
   * Resolves once fired settle-time work has landed.
   */
  settled?: (() => MaybePromise<void>) | undefined
}

/**
 * The open note documents, as one app-global service (foundations hardening,
 * post-Plan-07). This consolidates what used to be two parallel registries —
 * a quit-flush list and a path→session lookup — because they were both views
 * of the same fact: *these documents are open right now*.
 *
 * Consumers:
 * - **Quit teardown** ({@link OpenDocumentsService.flushAll}): every buffer
 *   flushes, and each document's settle-time work (pending title renames)
 *   fires and is awaited — the webview must not die before the writes land.
 *   React unmount effects never run on the quit paths, which is why this
 *   lives outside React.
 * - **Work that outlives a pane** ({@link OpenDocumentsService.sessionFor}):
 *   the rename coordinator's alias placement discovers whether its note is
 *   open (possibly *reopened* in a new pane) and routes through the live
 *   session's frontmatter channel instead of racing the disk under a dirty
 *   buffer.
 * - **External changes**: while any document is open, the service listens to
 *   the file-change stream and calls `externalChanged()` on every session
 *   whose current path has an upsert in the batch.
 */
export interface OpenDocumentsService {
  /**
   * Register an open document (keyed by its session's path); returns the
   * unregister. Unregistration is by **identity**, not key — a rename can
   * re-key the entry ({@link OpenDocumentsService.retarget}) between
   * registration and teardown, and the unregister must still find it.
   */
  register(document: OpenDocument): Unlisten
  /**
   * The live session for `path`, if that note is open in some pane.
   */
  sessionFor(path: string): NoteSession | null
  /**
   * Paths of open documents holding unsaved edits right now. The iCloud
   * conflict sweep (Plan 21) defers these, to avoid churning a note the user
   * is editing.
   */
  dirtyPaths(): string[]
  /**
   * Ask every open document to reconcile against disk, exactly as if a watcher
   * upsert had arrived for its path: an unchanged file is a no-op, a clean
   * buffer adopts silently, a dirty buffer saves at once and merges with the
   * disk text. The index
   * lifecycle calls this after each completed reconcile pass, because the pass
   * reads changed files into the index without emitting per-file events. On iOS
   * there is no file watcher, so a resume reconcile is the only signal a remote
   * edit produces: without this, an open note keeps stale content until relaunch.
   */
  reloadAll(): void
  /**
   * Re-key an open document after its note file moved (Plan 17), so
   * {@link OpenDocumentsService.sessionFor} lookups under the new path find
   * the live session. The entry moves only when it actually holds `session` —
   * a failed move's compensating re-key must never grab a *different* pane's
   * document that legitimately sits at `from` (then quit-time flush and
   * `sessionFor` would target the wrong path). The old registration's
   * unregister closure stays correct either way (it checks identity, not
   * keys), and the adopting pane re-registers under the new path.
   */
  retarget(from: string, to: string, session: NoteSession): void
  /**
   * Flush every open buffer, fire each document's pending settle-time work, and
   * settle once all of it has landed. Failures are surfaced per-document by the
   * save pipeline already; teardown must proceed past them, so rejections are
   * absorbed, never re-thrown.
   */
  flushAll(): Promise<void>
}

export interface OpenDocumentsServiceDeps {
  readonly fileChanges: FileChangeService
}

class OpenDocumentsServiceImpl implements OpenDocumentsService {
  readonly #deps: OpenDocumentsServiceDeps
  readonly #documents = new Map<string, OpenDocument>()
  // Every registration, including one a same-path registration hides from `#documents`.
  readonly #registrations = new Set<OpenDocument>()
  #stopFileChanges: Unlisten | null = null

  constructor(deps: OpenDocumentsServiceDeps) {
    this.#deps = deps
  }

  register(document: OpenDocument): Unlisten {
    this.#documents.set(document.session.path, document)
    this.#registrations.add(document)
    this.#stopFileChanges ??= this.#deps.fileChanges.subscribe(({ changes }) => {
      this.#onFileChanges(changes)
    })
    return () => {
      if (this.#registrations.delete(document) && this.#registrations.size === 0) {
        this.#stopFileChanges?.()
        this.#stopFileChanges = null
      }
      for (const [key, registered] of this.#documents) {
        if (registered === document) {
          this.#documents.delete(key)
          return
        }
      }
    }
  }

  sessionFor(path: string): NoteSession | null {
    return this.#documents.get(path)?.session ?? null
  }

  dirtyPaths(): string[] {
    return [...this.#documents.values()]
      .filter((document) => document.session.isDirty())
      .map((document) => document.session.path)
  }

  reloadAll(): void {
    for (const document of this.#documents.values()) {
      document.session.externalChanged()
    }
  }

  retarget(from: string, to: string, session: NoteSession): void {
    const document = this.#documents.get(from)
    if (document !== undefined && document.session === session) {
      this.#documents.delete(from)
      this.#documents.set(to, document)
    }
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#documents.values()].map(async (document) => {
        await document.session.flush()
        // Settle after the flush so the rename tracker has seen the final title;
        // settle() appends the rewrite synchronously, settled() awaits it.
        document.settle?.()
        await document.settled?.()
      }),
    )
  }

  #onFileChanges(changes: readonly FileChange[]): void {
    for (const document of this.#registrations) {
      // The session's current path, not the one it registered under: a rename
      // retargets the session before its pane re-renders.
      const { session } = document
      if (changes.some((change) => change.path === session.path && change.kind === 'upsert')) {
        session.externalChanged()
      }
    }
  }
}

export function createOpenDocumentsService(deps: OpenDocumentsServiceDeps): OpenDocumentsService {
  return new OpenDocumentsServiceImpl(deps)
}
