import { foldKey, hasAuthoredTitle, parseNote } from '@reflect/core'

/**
 * Settled-title detection for the auto-rename flow. A title change triggers a
 * graph-wide link rewrite *and* a file move (`docs/readable-filenames.md`),
 * so it must fire on **settled** titles only — never per keystroke: editing
 * "My Note" → "My Notebook" passes through garbage intermediate titles
 * ("My N…") as each debounced save lands, and rewriting backlinks to those
 * would spray the graph with junk.
 *
 * The tracker consumes the session's `onContent` stream and reduces it to at
 * most one pending event:
 *
 * - `load`/`external` content **re-baselines** — external edits never trigger
 *   rewrites, only edits the user made here;
 * - `saved` content arms (or re-arms) a quiet timer;
 * - a settle point (blur, pane teardown, quit) fires the pending event now.
 *
 * Two event shapes come out: a **rename** (`from` is the old title) and a
 * **birth** (`from: null` — the first authored title on an untitled note;
 * nothing links to a title that never existed, but the file still sheds its
 * placeholder name). Renames chain: the previous auto-added alias rides along
 * so a re-rename can prune it instead of accreting one alias per edit.
 */

export interface TitleRename {
  /**
   * The settled-away-from title — or `null` for a **birth**: the first
   * authored title on an untitled note. Births rewrite no links and add no
   * alias (nothing links to a title that never existed), but the file still
   * adopts its slug name (Plan 17), on the same settled cadence as renames.
   */
  from: string | null
  to: string
  /** The alias auto-added by this session's previous rename (prune candidate). */
  previousAutoAlias: string | null
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
  let pending: string | null = null
  let previousAutoAlias: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  // A title only counts when the *content* declares one (frontmatter `title:`
  // or an H1) — `hasAuthoredTitle`, the same predicate the title derivation
  // and the 17c migration share, so "is this note titled?" can never drift
  // between birth/rename detection and the rest of the app. parseNote falls
  // back to the filename stem for untitled notes — baselining on that would
  // make a fresh lazy note's first heading look like a rename from its ULID
  // filename, spraying a junk alias (and potentially rewrites) on every new
  // note. Untitled is `null` here.
  const titleOf = (content: string): string | null => {
    const parsed = parseNote({ path, source: content })
    return hasAuthoredTitle(parsed) ? parsed.title : null
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function fire(): void {
    cancelTimer()
    if (disposed || pending === null) {
      return
    }
    if (canFire !== undefined && !canFire()) {
      return // blocked (conflict parked): keep pending, mutate nothing
    }
    const rename: TitleRename = {
      from: baselineTitle,
      to: pending,
      previousAutoAlias: baselineTitle === null ? null : previousAutoAlias,
    }
    // The title we just renamed away from becomes this session's auto-alias —
    // a follow-up rename prunes it instead of accreting one alias per edit.
    // A birth (`from: null`) leaves no alias behind, so the chain stays empty.
    previousAutoAlias = baselineTitle
    baselineTitle = pending
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
    if (disposed) {
      return
    }
    const title = titleOf(content)
    if (title === null) {
      // The title was removed mid-edit (or the note is still untitled): there
      // is nothing to rename *to*. Clear any pending rename but keep the
      // baseline — re-titling later still compares against the old title.
      cancelTimer()
      pending = null
      return
    }
    if (baselineTitle === null) {
      // The first authored title on an untitled note is a **birth**, not a
      // rename — nothing links to a title that never existed, so no rewrite.
      // It still settles through the quiet timer: the birth event is what
      // moves the file onto its slug name (Plan 17), and firing it per save
      // would rename the file under a half-typed title.
      pending = title
      cancelTimer()
      timer = setTimeout(fire, quietMs)
      return
    }
    if (foldKey(title) === foldKey(baselineTitle)) {
      // Same key: resolution is case-insensitive, so a pure case tweak is not
      // a rename — and a reverted edit clears whatever was pending.
      cancelTimer()
      pending = null
      return
    }
    pending = title
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
