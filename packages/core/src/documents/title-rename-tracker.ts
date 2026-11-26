import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { hasAuthoredTitle, parseNote } from '../markdown/extract.ts'
import { foldKey } from '../markdown/keys.ts'

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
  /**
   * The title this session's previous rename left behind, or `null` when this
   * rename starts a new chain (a first rename, or external content re-baselined).
   */
  previousAutoAlias: string | null
}

export interface TitleRenameTrackerOptions {
  /**
   * Graph-relative path (feeds title derivation's path fallback).
   */
  path: string
  onRename: (rename: TitleRename) => void
  quietMs?: number | undefined
  /**
   * Runs the quiet timer.
   */
  clock: ClockService
}

export interface TitleRenameTracker {
  /**
   * New ground truth from disk (load / adopted external change): re-baseline.
   */
  baseline(content: string): void
  /**
   * A user-driven save landed; arms (or re-arms) the quiet timer.
   */
  saved(content: string): void
  /**
   * A settle point (blur, teardown): fire any pending rename now.
   */
  settle(): void
  dispose(): void
}

const DEFAULT_QUIET_MS = 5000

class TitleRenameTrackerImpl implements TitleRenameTracker {
  readonly #path: string
  readonly #onRename: (rename: TitleRename) => void
  readonly #clock: ClockService
  readonly #quietMs: number
  #baselineTitle: string | null = null
  #pending: string | null = null
  #previousAutoAlias: string | null = null
  #timer: TimerHandle | null = null
  #disposed = false

  constructor(options: TitleRenameTrackerOptions) {
    this.#path = options.path
    this.#onRename = options.onRename
    this.#clock = options.clock
    this.#quietMs = options.quietMs ?? DEFAULT_QUIET_MS
  }

  baseline(content: string): void {
    this.#cancelTimer()
    this.#pending = null
    this.#baselineTitle = this.#titleOf(content)
    // External content is a new ground truth: the alias chain this session was
    // building no longer describes it, so pruning stops here.
    this.#previousAutoAlias = null
  }

  saved(content: string): void {
    if (this.#disposed) {
      return
    }
    const title = this.#titleOf(content)
    if (title === null) {
      // The title was removed mid-edit (or the note is still untitled): there
      // is nothing to rename *to*. Clear any pending rename but keep the
      // baseline — re-titling later still compares against the old title.
      this.#cancelTimer()
      this.#pending = null
      return
    }
    if (this.#baselineTitle === null) {
      // The first authored title on an untitled note is a **birth**, not a
      // rename — nothing links to a title that never existed, so no rewrite.
      // It still settles through the quiet timer: the birth event is what
      // moves the file onto its slug name (Plan 17), and firing it per save
      // would rename the file under a half-typed title.
      this.#pending = title
      this.#cancelTimer()
      this.#timer = this.#clock.setTimeout(this.#fire, this.#quietMs)
      return
    }
    if (foldKey(title) === foldKey(this.#baselineTitle)) {
      // Same key: resolution is case-insensitive, so a pure case tweak is not
      // a rename — and a reverted edit clears whatever was pending.
      this.#cancelTimer()
      this.#pending = null
      return
    }
    this.#pending = title
    this.#cancelTimer()
    this.#timer = this.#clock.setTimeout(this.#fire, this.#quietMs)
  }

  settle(): void {
    if (this.#pending !== null) {
      this.#fire()
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#cancelTimer()
    this.#pending = null
  }

  // A title only counts when the *content* declares one (frontmatter `title:`
  // or an H1) — `hasAuthoredTitle`, the same predicate the title derivation
  // and the 17c migration share, so "is this note titled?" can never drift
  // between birth/rename detection and the rest of the app. parseNote falls
  // back to the filename stem for untitled notes — baselining on that would
  // make a fresh lazy note's first heading look like a rename from its ULID
  // filename, spraying a junk alias (and potentially rewrites) on every new
  // note. Untitled is `null` here.
  #titleOf(content: string): string | null {
    const parsed = parseNote({ path: this.#path, source: content })
    return hasAuthoredTitle(parsed) ? parsed.title : null
  }

  #cancelTimer(): void {
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  readonly #fire = (): void => {
    this.#cancelTimer()
    if (this.#disposed || this.#pending === null) {
      return
    }
    const rename: TitleRename = {
      from: this.#baselineTitle,
      to: this.#pending,
      previousAutoAlias: this.#baselineTitle === null ? null : this.#previousAutoAlias,
    }
    // The title we just renamed away from marks the chain: a follow-up rename
    // prunes what this one added instead of accreting one alias per edit. A
    // birth (`from: null`) leaves no alias behind, so the chain stays empty.
    this.#previousAutoAlias = this.#baselineTitle
    this.#baselineTitle = this.#pending
    this.#pending = null
    this.#onRename(rename)
  }
}

export function createTitleRenameTracker(options: TitleRenameTrackerOptions): TitleRenameTracker {
  return new TitleRenameTrackerImpl(options)
}
