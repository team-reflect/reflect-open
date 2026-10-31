import type { MaybePromise } from '@reflect/utils'
import type { NoteSession } from './note-session-types.ts'
import type { OpenDocumentsService } from './open-documents-service.ts'

/**
 * One pane's document lifecycle policy (Plan 17), extracted from
 * `useNoteDocument`'s effect so the create/adopt/teardown/hand-off protocol
 * is explicit and unit-testable instead of implied by ref comparisons.
 *
 * Per **bind** it decides between:
 * - **create** — a fresh session (and coordinator) for the path; the caller
 *   loads it. Any same-path rebind (changed io deps) recreates too: a
 *   session's io bindings are taken at construction.
 * - **adopt** — a rename just retargeted the live session to this path and
 *   the route followed; the document, coordinator, and editor all continue.
 *
 * Per **unbind** it decides between:
 * - **teardown now** — the normal pane close / note switch: unregister,
 *   flush to the session's own path, dispose, settle pending renames.
 * - **hand off** — the session was retargeted away from the unbound path: an
 *   adopting bind() lands synchronously in the same React commit, and only
 *   if none does (the pane really unmounted) does a deferred check tear the
 *   session down — a moved document must never flush over its old home, and
 *   an unadopted one must never leak.
 *
 * The desktop hook's effect drives it like so (see `use-note-document.ts`):
 *
 * ```ts
 * useEffect(() => {
 *   const { session, created } = binding.bind(path, {
 *     coordinator: () => titleRename.createCoordinator({ ... }),
 *     session: (coordinator) => noteSessions.create({ ... }),
 *   })
 *   if (created) session.load()            // adopted sessions are already live
 *   return () => binding.unbind(path)
 * }, [path, ...])
 * // …and the editor is keyed on binding.epoch(), not the path, so a rename
 * // that retargets the session never remounts it — the cursor survives.
 * ```
 *
 * Why a rename leads here: `docs/readable-filenames.md`.
 */

/**

 * What a binding needs from the coordinator that owns a document's settle-time work.

 */
export interface DocumentCoordinator {
  /**
   * A settle point (blur, teardown, quit): fire any pending work now.
   */
  settle(): void
  /**
   * Resolves once fired settle-time work has landed.
   */
  settled(): MaybePromise<void>
  dispose(): void
}

export interface BindFactories<Coordinator extends DocumentCoordinator = DocumentCoordinator> {
  /**
   * Build the session; receives the coordinator its `onContent` feeds.
   */
  session: (coordinator: Coordinator | null) => NoteSession
  coordinator: () => Coordinator | null
}

export interface BoundDocument<Coordinator extends DocumentCoordinator = DocumentCoordinator> {
  session: NoteSession
  coordinator: Coordinator | null
  /**
   * False when a retargeted live session was adopted instead of created.
   */
  created: boolean
}

export interface DocumentBinding<Coordinator extends DocumentCoordinator = DocumentCoordinator> {
  /**
   * Bind the pane to `path`, creating or adopting. One unbind per bind.
   */
  bind(path: string, create: BindFactories<Coordinator>): BoundDocument<Coordinator>
  /**
   * Release the bind for `path`: teardown, or hand-off when retargeted.
   */
  unbind(path: string): void
  /**
   * The live session, if any — callbacks read this, never a stale ref.
   */
  session(): NoteSession | null
  coordinator(): Coordinator | null
  /**
   * Counts session *creations* (not adoptions) — the editor's remount key.
   */
  epoch(): number
}

export interface DocumentBindingDeps {
  readonly openDocuments: OpenDocumentsService
}

class DocumentBindingImpl<
  Coordinator extends DocumentCoordinator = DocumentCoordinator,
> implements DocumentBinding<Coordinator> {
  readonly #deps: DocumentBindingDeps
  #session: NoteSession | null = null
  #coordinator: Coordinator | null = null
  /**
   * The previous bind's path: adoption requires the path to have *changed*.
   */
  #lastPath: string | null = null
  #epoch = 0
  /**
   * Bumped per bind — the deferred hand-off check for unadopted sessions.
   */
  #runId = 0
  #unregister: (() => void) | null = null

  constructor(deps: DocumentBindingDeps) {
    this.#deps = deps
  }

  bind(path: string, create: BindFactories<Coordinator>): BoundDocument<Coordinator> {
    this.#runId += 1
    const adopted =
      this.#session !== null && this.#session.path === path && this.#lastPath !== path
        ? this.#session
        : null
    let bound: NoteSession
    let owner: Coordinator | null
    if (adopted !== null) {
      bound = adopted
      owner = this.#coordinator
    } else {
      owner = create.coordinator()
      bound = create.session(owner)
      this.#epoch += 1
    }
    this.#session = bound
    this.#coordinator = owner
    this.#lastPath = path
    // One registration covers everything app-global teardown needs: the
    // quit-time flush, settle-time rename work, and reopened-note lookups.
    this.#unregister = this.#deps.openDocuments.register({
      session: bound,
      ...(owner ? { settle: () => owner.settle(), settled: () => owner.settled() } : {}),
    })
    return { session: bound, coordinator: owner, created: adopted === null }
  }

  unbind(path: string): void {
    const target = this.#session
    const owner = this.#coordinator
    // Unregister first (by identity — a rename may have re-keyed the
    // entry): a rename settling from this teardown must not see this
    // session as "open" — its alias goes to disk (or to a reopened pane's
    // live session, which registers under the same path).
    this.#unregister?.()
    this.#unregister = null
    if (target === null) {
      return
    }
    if (target.path !== path) {
      // Retargeted away: an adopting bind() lands before this microtask
      // (same React commit, synchronous) and bumps runId; otherwise the
      // pane really unmounted and the session must still be torn down.
      const bindId = this.#runId
      queueMicrotask(() => {
        if (this.#runId === bindId && this.#session === target) {
          this.#teardown(target, owner)
        }
      })
      return
    }
    this.#teardown(target, owner)
  }

  session(): NoteSession | null {
    return this.#session
  }

  coordinator(): Coordinator | null {
    return this.#coordinator
  }

  epoch(): number {
    return this.#epoch
  }

  #teardown(target: NoteSession, owner: Coordinator | null): void {
    // Disposal flushes pending edits to the session's own (current) path —
    // the note-switch "final flush". The flush's landed save reaches the
    // rename tracker via onContent('saved'); settle after it so a just-edited
    // title still renames on the way out.
    const settled = target.flush()
    // `flush()` may synchronously report reconciled editor input through the
    // change callback. Keep the target discoverable for that re-entry, then
    // release ownership before any asynchronous write settles or a replacement
    // session binds.
    if (this.#session === target) {
      this.#session = null
      this.#coordinator = null
    }
    target.dispose()
    if (owner) {
      void settled.then(() => {
        owner.settle()
        owner.dispose()
      })
    }
  }
}

export function createDocumentBinding<
  Coordinator extends DocumentCoordinator = DocumentCoordinator,
>(deps: DocumentBindingDeps): DocumentBinding<Coordinator> {
  return new DocumentBindingImpl<Coordinator>(deps)
}
