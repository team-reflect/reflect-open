import {
  errorMessage,
  isReflectManagedNote,
  isReflectManagedNotePath,
  listFiles,
  prepareNoteMoveRewrites,
  readNote,
  resolveExistingWikiTarget,
  rewriteLinksForTitleChange,
  slugPathForTitle,
  type PreparedNoteMoveRewrite,
  writeNoteIfUnchanged,
} from '@reflect/core'
import { placeOldTitleAlias } from './alias-placement'
import { moveNoteCarryingSession } from './move-note'
import type { NoteContentOrigin } from './note-session'
import { openSession } from './open-documents'
import { composeRenameFailure, type RenamePhaseFailures } from './rename-failure'
import { startOperation } from '@/lib/operations'
import { createTitleRenameTracker } from './title-rename'
import type { TitleRename } from './title-rename'

/**
 * Owns one Reflect-managed note's auto-rename lifecycle: the settled-title
 * tracker, the serialized rewrite chain, where the old-title alias lands —
 * and the **file move** that keeps the filename a projection of the title
 * (`docs/readable-filenames.md`).
 *
 * A settled rename runs three phases, each failing independently with an
 * honest report (see `rename-failure.ts`):
 *
 * 1. **Rewrite** inbound `[[old title]]` links across the graph;
 * 2. **Alias** the old title onto this note (`alias-placement.ts`) — the
 *    safety net for links the rewrite missed;
 * 3. **Move** the file onto the new title's slug (`move-note.ts`).
 *
 * A *birth* (the first authored title on an untitled note) runs phase 3
 * alone: nothing links to a title that never existed.
 *
 * Extracted from `useNoteDocument` for the same reason the session was —
 * lifecycle coupling (pane teardown, quit, note switches) belongs to an owned
 * object, not to effect-closure flags. The rename path holds no React ref and
 * no session of its own: session liveness comes from the open-documents
 * service at placement time, and status surfaces through the global
 * operations store — a rename is app-level background work, not pane state.
 *
 * The coordinator tracks its note's **current** path: a landed move retargets
 * the live session, the open-documents registration, and this coordinator in
 * place, so a follow-up rename in the same pane session continues the alias
 * chain against the right file.
 */

export interface RenameCoordinatorOptions {
  /** Graph-relative path of the (possibly renamed) note. */
  path: string
  /** Read the graph generation at rewrite time — never captured early. */
  generation: () => number | null
  /**
   * Gate: no rename fires while false (a parked conflict contests the very
   * content the title came from; "keep mine" re-arms, "load theirs" cancels).
   */
  canFire: () => boolean
}

export interface RenameCoordinator {
  /** Wire into the session's `onContent` stream (load/external/saved). */
  content(content: string, origin: NoteContentOrigin): void
  /** Follow the live session when a file move retargets it. */
  retarget(to: string): void
  /** A settle point (blur, teardown, quit): fire any pending rename now. */
  settle(): void
  /** Resolves once settled renames' writes have landed (quit awaits this). */
  settled(): Promise<void>
  dispose(): void
}

export function createRenameCoordinator(options: RenameCoordinatorOptions): RenameCoordinator {
  const { generation, canFire } = options
  /** The note's current path — a landed move advances it (Plan 17). */
  let currentPath = options.path
  let latestContent: string | null = null
  /** Serializes rewrites — a second settle waits for the first. */
  let chain: Promise<void> = Promise.resolve()

  /**
   * Compare-and-swap a rewrite through a live session when one owns the
   * source. Closed sources use the generation-pinned native conditional write
   * so the expected-byte comparison no longer spans an IPC round-trip.
   */
  async function commitExactRewrite(
    path: string,
    expected: string,
    replacement: string,
    gen: number,
  ): Promise<void> {
    const owner = openSession(path)
    if (owner !== null) {
      if (!(await owner.commitExactContentReplacement(expected, replacement))) {
        throw new Error(`local link source changed before rewrite: ${path}`)
      }
      return
    }
    const outcome = await writeNoteIfUnchanged(path, expected, replacement, gen)
    if (outcome.kind === 'changed') {
      throw new Error(`local link source changed before rewrite: ${path}`)
    }
  }

  async function rollbackPreparedRewrites(
    rewrites: readonly PreparedNoteMoveRewrite[],
    gen: number,
  ): Promise<string[]> {
    const failed: string[] = []
    for (const rewrite of [...rewrites].reverse()) {
      try {
        await commitExactRewrite(rewrite.path, rewrite.after, rewrite.before, gen)
      } catch {
        failed.push(rewrite.path)
      }
    }
    return failed
  }

  /**
   * Move the file onto its title's slug path (Plan 17). A failed move leaves
   * the filename drifting (cosmetic — resolution never reads filenames) until
   * the next settled rename re-derives it.
   */
  const runMove = async (
    title: string,
    gen: number,
    manifest?: readonly string[],
  ): Promise<void> => {
    const target = await slugPathForTitle(currentPath, title)
    if (target === currentPath) {
      return
    }
    const notePaths = manifest ?? (await listFiles(gen)).map((file) => file.path)
    const prepared = await prepareNoteMoveRewrites({
      fromPath: currentPath,
      toPath: target,
      notePaths,
      read: async (path) => {
        const owner = openSession(path)
        if (owner === null) {
          return readNote(path, gen)
        }
        const live = owner.liveContent()
        if (live === null) {
          throw new Error(`local link source is not loaded: ${path}`)
        }
        return live
      },
    })
    if (prepared.failed.length > 0) {
      throw new Error(
        `could not safely rewrite local links in: ${prepared.failed.join(', ')}`,
      )
    }
    const applied: PreparedNoteMoveRewrite[] = []
    try {
      for (const rewrite of prepared.rewrites) {
        await commitExactRewrite(rewrite.path, rewrite.before, rewrite.after, gen)
        applied.push(rewrite)
      }
      await moveNoteCarryingSession(currentPath, target, gen)
    } catch (cause) {
      const rollbackFailures = await rollbackPreparedRewrites(applied, gen)
      if (rollbackFailures.length > 0) {
        throw new Error(
          `${errorMessage(cause)}; additionally failed to restore links in: ${rollbackFailures.join(', ')}`,
        )
      }
      throw cause
    }
    currentPath = target
  }

  // Rewrite inbound links across the graph, record the old title as an alias
  // on this note, then move the file onto the new title's slug. Every write
  // carries the generation read at run time (stale → loud rejection in Rust —
  // a rename pending across a graph switch is dropped, never cross-written).
  const runRename = (rename: TitleRename): void => {
    chain = chain.then(async () => {
      const gen = generation()
      if (gen === null) {
        // Unreachable in the current wiring (a rename only arms after a save,
        // which requires a generation; an unmounted pane's ref keeps its
        // non-null value) — but the tracker's baseline has already advanced,
        // so if a future caller gets here the drop must be loud, not silent.
        console.error(
          `rename dropped (no graph generation): "${rename.from ?? ''}" → "${rename.to}" on ${currentPath}`,
        )
        return
      }
      if (rename.from === null) {
        // A birth: the first authored title on an untitled note. Nothing
        // links to a title that never existed — no rewrite, no alias — but
        // the file sheds its placeholder name for the title's slug.
        const operation = startOperation(`Naming "${rename.to}"`)
        try {
          await runMove(rename.to, gen)
          operation.done()
        } catch (cause) {
          console.error('note file move failed:', cause)
          operation.fail(
            `${errorMessage(cause)} — the note keeps its placeholder filename; the title and its links are unaffected`,
          )
        }
        return
      }
      const from = rename.from
      const operation = startOperation(`Renaming "${from}" → "${rename.to}"`)
      // The phases fail independently and the report says what held — the
      // permutations live in `composeRenameFailure`.
      const failures: RenamePhaseFailures = { rewrite: null, alias: null, move: null }
      try {
        let collision = false
        let liveNotePaths: string[] | null = null
        try {
          liveNotePaths = (await listFiles(gen)).map((file) => file.path)
          const expectedBySource = new Map<string, string>()
          const result = await rewriteLinksForTitleChange({
            path: currentPath,
            from,
            to: rename.to,
            io: {
              // Scan every live note, not only indexed backlink candidates:
              // a just-authored [[old title]] must not be missed during lag.
              sources: async () => liveNotePaths ?? [],
              read: async (forPath) => {
                const owner = openSession(forPath)
                let content: string
                if (owner === null) {
                  content = await readNote(forPath, gen)
                } else {
                  const live = owner.liveContent()
                  if (live === null) {
                    throw new Error(`local link source is not loaded: ${forPath}`)
                  }
                  content = live
                }
                expectedBySource.set(forPath, content)
                return content
              },
              write: async (forPath, contents) => {
                const expected = expectedBySource.get(forPath)
                if (expected === undefined) {
                  throw new Error(`local link source was not read before rewrite: ${forPath}`)
                }
                expectedBySource.delete(forPath)
                await commitExactRewrite(forPath, expected, contents, gen)
              },
              resolve: (target) => resolveExistingWikiTarget(target, gen),
            },
            onProgress: operation.progress,
          })
          collision = result.collision
          if (result.failed.length > 0) {
            throw new Error(
              `could not safely rewrite title links in: ${result.failed.join(', ')}`,
            )
          }
        } catch (cause) {
          // A failed rewrite must NOT skip the alias below: the tracker's
          // baseline has already advanced (re-arming would re-fire with a
          // stale `from` after further edits), so the alias is the safety
          // net that keeps every un-rewritten link resolving to this note.
          failures.rewrite = errorMessage(cause)
          console.error('rename link rewrite failed:', cause)
        }
        if (!collision) {
          try {
            await placeOldTitleAlias(currentPath, { ...rename, from }, gen)
          } catch (cause) {
            failures.alias = errorMessage(cause)
            console.error('rename alias placement failed:', cause)
          }
        }
        // The collision guard above is about the OLD title's links — when the
        // old title belongs to a different note now, links stay theirs and no
        // alias is claimed. The *filename* derives from the NEW title, so the
        // move happens regardless.
        try {
          await runMove(rename.to, gen, liveNotePaths ?? undefined)
        } catch (cause) {
          failures.move = errorMessage(cause)
          console.error('note file move failed:', cause)
        }
      } finally {
        const failure = composeRenameFailure(from, failures)
        if (failure !== null) {
          operation.fail(failure)
        } else {
          operation.done()
        }
      }
    })
  }

  const tracker = createTitleRenameTracker({
    path: options.path,
    onRename: runRename,
    canFire,
  })

  return {
    content(content: string, origin: NoteContentOrigin): void {
      latestContent = content
      if (origin === 'saved') {
        // Only direct `notes/*.md` files carrying a valid Reflect ULID opt in
        // to graph-wide automation. Adopted vault files save their content in
        // place; a retitle never moves them, rewrites links, or adds aliases.
        if (isReflectManagedNote(currentPath, content)) {
          tracker.saved(content)
        } else {
          tracker.baseline(content)
        }
      } else {
        tracker.baseline(content) // load/external: new ground truth, no rewrite
      }
    },
    retarget(to: string): void {
      const leftManagedTree =
        isReflectManagedNotePath(currentPath) && !isReflectManagedNotePath(to)
      currentPath = to
      // A saved title may still be waiting for the quiet-period settle. Once
      // the file is adopted outside direct notes/, cancel that pending managed
      // automation against the latest bytes.
      if (leftManagedTree && latestContent !== null) {
        tracker.baseline(latestContent)
      }
    },
    settle(): void {
      tracker.settle()
    },
    settled(): Promise<void> {
      return chain
    },
    dispose(): void {
      tracker.dispose()
    },
  }
}
