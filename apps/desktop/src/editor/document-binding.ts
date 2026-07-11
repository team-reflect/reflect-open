import type { NoteSession } from './note-session'
import { registerOpenDocument } from './open-documents'
import type { RenameCoordinator } from './rename-coordinator'

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
 * The hook's effect drives it like so (see `use-note-document.ts`):
 *
 * ```ts
 * useEffect(() => {
 *   const { session, created } = binding.bind(path, {
 *     coordinator: () => createRenameCoordinator({ ... }),
 *     session: (coordinator) => createNoteSession({ ... }),
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

export interface BindFactories {
  /** Build the session; receives the coordinator its `onContent` feeds. */
  session: (coordinator: RenameCoordinator | null) => NoteSession
  coordinator: () => RenameCoordinator | null
}

export interface BoundDocument {
  session: NoteSession
  coordinator: RenameCoordinator | null
  /** False when a retargeted live session was adopted instead of created. */
  created: boolean
}

export interface DocumentBinding {
  /** Bind the pane to `path`, creating or adopting. One unbind per bind. */
  bind(path: string, create: BindFactories): BoundDocument
  /** Release the bind for `path`: teardown, or hand-off when retargeted. */
  unbind(path: string): void
  /** The live session, if any — callbacks read this, never a stale ref. */
  session(): NoteSession | null
  coordinator(): RenameCoordinator | null
  /** Counts session *creations* (not adoptions) — the editor's remount key. */
  epoch(): number
}

export function createDocumentBinding(): DocumentBinding {
  let session: NoteSession | null = null
  let coordinator: RenameCoordinator | null = null
  /** The previous bind's path: adoption requires the path to have *changed*. */
  let lastPath: string | null = null
  let epoch = 0
  /** Bumped per bind — the deferred hand-off check for unadopted sessions. */
  let runId = 0
  let unregister: (() => void) | null = null

  function teardown(target: NoteSession, owner: RenameCoordinator | null): void {
    // Disposal flushes pending edits to the session's own (current) path —
    // the note-switch "final flush". The flush's landed save reaches the
    // rename tracker via onContent('saved'); settle after it so a just-edited
    // title still renames on the way out.
    const settled = target.flush()
    // `flush()` synchronously asks the live editor to reconcile native input;
    // Meowdown reports a resulting document change through onDocChange. Keep
    // the target discoverable for that callback, then release ownership before
    // any asynchronous write settles or a replacement session binds.
    if (session === target) {
      session = null
      coordinator = null
    }
    target.dispose()
    if (owner) {
      void settled.then(() => {
        owner.settle()
        owner.dispose()
      })
    }
  }

  return {
    bind(path: string, create: BindFactories): BoundDocument {
      runId += 1
      const adopted =
        session !== null && session.path === path && lastPath !== path ? session : null
      let bound: NoteSession
      let owner: RenameCoordinator | null
      if (adopted !== null) {
        bound = adopted
        owner = coordinator
      } else {
        owner = create.coordinator()
        bound = create.session(owner)
        epoch += 1
      }
      session = bound
      coordinator = owner
      lastPath = path
      // One registration covers everything app-global teardown needs: the
      // quit-time flush, settle-time rename work, and reopened-note lookups.
      unregister = registerOpenDocument({
        session: bound,
        ...(owner
          ? { settle: () => owner.settle(), settled: () => owner.settled() }
          : {}),
      })
      return { session: bound, coordinator: owner, created: adopted === null }
    },

    unbind(path: string): void {
      const target = session
      const owner = coordinator
      // Unregister first (by identity — a rename may have re-keyed the
      // entry): a rename settling from this teardown must not see this
      // session as "open" — its alias goes to disk (or to a reopened pane's
      // live session, which registers under the same path).
      unregister?.()
      unregister = null
      if (target === null) {
        return
      }
      if (target.path !== path) {
        // Retargeted away: an adopting bind() lands before this microtask
        // (same React commit, synchronous) and bumps runId; otherwise the
        // pane really unmounted and the session must still be torn down.
        const bindId = runId
        queueMicrotask(() => {
          if (runId === bindId && session === target) {
            teardown(target, owner)
          }
        })
        return
      }
      teardown(target, owner)
    },

    session: () => session,
    coordinator: () => coordinator,
    epoch: () => epoch,
  }
}
