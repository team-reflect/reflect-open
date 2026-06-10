import { foldKey, parseNote } from '@reflect/core'

/**
 * Settled-title detection for the auto-rename flow (Plan 07b). A title change
 * triggers a graph-wide link rewrite, so it must fire on **settled** titles
 * only — never per keystroke: editing "My Note" → "My Notebook" passes through
 * garbage intermediate titles ("My N…") as each debounced save lands, and
 * rewriting backlinks to those would spray the graph with junk.
 *
 * The tracker consumes the session's `onContent` stream: `load`/`external`
 * content re-baselines (external edits never trigger rewrites — only edits
 * the user made here), `saved` content arms a quiet timer, and a settle point
 * (blur, pane teardown) fires the pending rename immediately. Renames chain:
 * the previous auto-added alias rides along so a re-rename can prune it.
 */

export interface TitleRename {
  from: string
  to: string
  /** The alias auto-added by this session's previous rename (prune candidate). */
  previousAutoAlias: string | null
  /** The full document content at the settle that fired this rename. */
  content: string
}

export interface TitleRenameTrackerOptions {
  /** Graph-relative path (feeds title derivation's path fallback). */
  path: string
  onRename: (rename: TitleRename) => void
  /**
   * Gate checked at fire time (e.g. "no conflict is parked"). When false the
   * pending rename is kept, not dropped: a post-resolution save re-arms it
   * ("keep mine"), while adopted external content clears it via `baseline`
   * ("load theirs") — exactly the two ways a conflict can end.
   */
  canFire?: () => boolean
  quietMs?: number
}

export interface TitleRenameTracker {
  /** New ground truth from disk (load / adopted external change): re-baseline. */
  baseline(content: string): void
  /** A user-driven save landed; arms (or re-arms) the quiet timer. */
  saved(content: string): void
  /** A settle point (blur, teardown): fire any pending rename now. */
  settle(): void
  dispose(): void
}

const DEFAULT_QUIET_MS = 5000

export function createTitleRenameTracker(options: TitleRenameTrackerOptions): TitleRenameTracker {
  const { path, onRename, canFire } = options
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS

  let baselineTitle: string | null = null
  let pending: { title: string; content: string } | null = null
  let previousAutoAlias: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const titleOf = (content: string): string => parseNote({ path, source: content }).title

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function fire(): void {
    cancelTimer()
    if (disposed || pending === null || baselineTitle === null) {
      return
    }
    if (canFire !== undefined && !canFire()) {
      return // blocked (conflict parked): keep pending, mutate nothing
    }
    const rename: TitleRename = {
      from: baselineTitle,
      to: pending.title,
      previousAutoAlias,
      content: pending.content,
    }
    // The title we just renamed away from becomes this session's auto-alias —
    // a follow-up rename prunes it instead of accreting one alias per edit.
    previousAutoAlias = baselineTitle
    baselineTitle = pending.title
    pending = null
    onRename(rename)
  }

  function baseline(content: string): void {
    cancelTimer()
    pending = null
    baselineTitle = titleOf(content)
    // External content is a new ground truth: the alias chain this session was
    // building no longer describes it, so pruning stops here.
    previousAutoAlias = null
  }

  function saved(content: string): void {
    if (disposed || baselineTitle === null) {
      return
    }
    const title = titleOf(content)
    if (foldKey(title) === foldKey(baselineTitle)) {
      // Same key: resolution is case-insensitive, so a pure case tweak is not
      // a rename — and a reverted edit clears whatever was pending.
      cancelTimer()
      pending = null
      return
    }
    pending = { title, content }
    cancelTimer()
    timer = setTimeout(fire, quietMs)
  }

  function settle(): void {
    if (pending !== null) {
      fire()
    }
  }

  function dispose(): void {
    disposed = true
    cancelTimer()
    pending = null
  }

  return { baseline, saved, settle, dispose }
}
