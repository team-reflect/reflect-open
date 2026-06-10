import {
  getLinkSources,
  nextAliases,
  parseNote,
  readNote,
  resolveWikiTarget,
  rewriteLinksForTitleChange,
  upsertFrontmatter,
  writeNote,
} from '@reflect/core'
import type { NoteContentOrigin, NoteSession } from './note-session'
import { liveSession } from './session-registry'
import { createTitleRenameTracker } from './title-rename'
import type { TitleRename } from './title-rename'

/**
 * Owns one note's auto-rename lifecycle (Plan 07b): the settled-title tracker,
 * the serialized rewrite chain, and where the old-title alias lands. Extracted
 * from `useNoteDocument` for the same reason the session was — lifecycle
 * coupling (pane teardown, quit, note switches) belongs to an owned object,
 * not to effect-closure flags; the rename path never touches a React ref, so
 * it cannot observe another note's session no matter when it resolves.
 */

export interface RenameProgress {
  done: number
  total: number
}

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
  /** Rewrite progress for the pane; `null` when idle. */
  onProgress: (progress: RenameProgress | null) => void
}

export interface RenameCoordinator {
  /** Bind the owning session; aliases route through it while the pane is open. */
  bind(session: NoteSession): void
  /** Wire into the session's `onContent` stream (load/external/saved). */
  content(content: string, origin: NoteContentOrigin): void
  /** A settle point (blur, teardown, quit): fire any pending rename now. */
  settle(): void
  /** Resolves once settled renames' writes have landed (quit awaits this). */
  settled(): Promise<void>
  /** Pane teardown: alias placement switches to direct disk writes. */
  close(): void
  dispose(): void
}

export function createRenameCoordinator(options: RenameCoordinatorOptions): RenameCoordinator {
  const { path, generation, canFire, onProgress } = options
  let session: NoteSession | null = null
  let paneClosed = false
  /** Serializes rewrites — a second settle waits for the first. */
  let chain: Promise<void> = Promise.resolve()

  // Rewrite inbound links across the graph, then record the old title as an
  // alias on this note. Every write carries the generation read at run time
  // (stale → loud rejection in Rust — a rename pending across a graph switch
  // is dropped, never cross-written).
  const runRename = (rename: TitleRename): void => {
    chain = chain.then(async () => {
      const gen = generation()
      if (gen === null) {
        // Unreachable in the current wiring (a rename only arms after a save,
        // which requires a generation; an unmounted pane's ref keeps its
        // non-null value) — but the tracker's baseline has already advanced,
        // so if a future caller gets here the drop must be loud, not silent.
        console.error(
          `rename dropped (no graph generation): "${rename.from}" → "${rename.to}" on ${path}`,
        )
        return
      }
      try {
        let collision = false
        try {
          const result = await rewriteLinksForTitleChange({
            path,
            from: rename.from,
            to: rename.to,
            io: {
              sources: getLinkSources,
              read: readNote,
              write: (forPath, contents) => writeNote(forPath, contents, gen),
              resolve: resolveWikiTarget,
            },
            onProgress: (done, total) => onProgress({ done, total }),
          })
          collision = result.collision
        } catch (cause) {
          // A failed rewrite must NOT skip the alias below: the tracker's
          // baseline has already advanced (re-arming would re-fire with a
          // stale `from` after further edits), so the alias is the safety
          // net that keeps every un-rewritten link resolving to this note.
          console.error('rename link rewrite failed:', cause)
        }
        if (collision) {
          // The old title belongs to a different note now: links were left
          // resolving there, and claiming it as *our* alias would plant a
          // competing key — one that never wins while the other note exists,
          // then silently re-points links to us if it's ever deleted.
          return
        }
        // Compute against the note's *current* aliases at placement time —
        // `aliases` replaces the whole key, and the settle-time snapshot can
        // be stale (an external edit adopted mid-rewrite, a racing chained
        // rename): replacing from it would drop concurrently-gained entries.
        const aliasesOf = (source: string): string[] =>
          parseNote({ path, source }).frontmatter.aliases
        // Route through a session whenever one is open: the bound one while
        // this pane lives, or a *reopened* pane's live session afterwards —
        // a direct disk write under a reopened dirty buffer would park a
        // conflict caused by our own background work, and "keep mine" would
        // silently drop the alias.
        const owner = !paneClosed && session !== null ? session : liveSession(path)
        let placed = false
        if (owner !== null) {
          // Read and patch in the same tick (no await between): atomic against
          // the session. Through its frontmatter channel — the editor view
          // never churns — and flushed rather than riding the debounce: a
          // settle is exactly the moment to persist, and quit-time teardown
          // awaits this chain.
          const aliases = nextAliases(aliasesOf(owner.content()), rename)
          placed = aliases === null || owner.updateFrontmatter({ aliases })
          if (placed && aliases !== null) {
            await owner.flush()
          }
        }
        if (!placed) {
          // No live session (or it can't take patches — e.g. still loading):
          // write directly to disk; a loading/clean session reconciles it
          // like any external change, and a header-only patch is body-safe
          // even for protected notes.
          const content = await readNote(path)
          const aliases = nextAliases(aliasesOf(content), rename)
          if (aliases !== null) {
            const patched = upsertFrontmatter(content, { aliases })
            if (patched !== content) {
              await writeNote(path, patched, gen)
            }
          }
        }
      } catch (cause) {
        console.error('rename alias placement failed:', cause)
      } finally {
        onProgress(null)
      }
    })
  }

  const tracker = createTitleRenameTracker({ path, onRename: runRename, canFire })

  return {
    bind(owner: NoteSession): void {
      session = owner
    },
    content(content: string, origin: NoteContentOrigin): void {
      if (origin === 'saved') {
        tracker.saved(content)
      } else {
        tracker.baseline(content) // load/external: new ground truth, no rewrite
      }
    },
    settle(): void {
      tracker.settle()
    },
    settled(): Promise<void> {
      return chain
    },
    close(): void {
      paneClosed = true
      session = null
    },
    dispose(): void {
      tracker.dispose()
    },
  }
}
