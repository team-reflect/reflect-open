# Performance Pass (2026-06-20) — Final Report

**Branch:** `claude/performance-pass-20260620` (based on `origin/next` @ 7225f2e)
**Code commit:** `1d08a2b98d07ae390a12fe265ba43bd4c587ecf5` (docs commit on top)
**PR:** https://github.com/team-reflect/reflect-open/pull/294 (→ `next`)

---

## Objective

A serious performance pass across Reflect Open's high-frequency paths — daily
stream scrolling, opening/switching notes, editor mount/update, note
lists/search/backlinks/context panes, and repeated data fetching / render churn —
without duplicating the prior pass (PR #233, `docs/performance-pass/`).

## Method

1. Grounded in the prior pass and the hot-path code (it is already carefully
   optimized: uncontrolled editor with ref-read callbacks, stable session-epoch
   keying, split focused-daily contexts, memoized provider values, virtualized
   stream with ref-write scroll save, deferred palette query, structural
   sharing on all index queries).
2. Ran a 5-area parallel audit (daily-stream, editor, invalidation,
   lists/search, context-panes); each candidate was adversarially verified for
   real impact, behavior preservation, and non-duplication of #233. Result:
   **7 confirmed, 14 rejected**.
3. Implemented the high-confidence, behavior-preserving subset with focused
   tests, then verified.

## Changes (changed files + reasoning)

All are behavior-preserving memoizations following #233's `React.memo`/`useMemo`
pattern. None touch persistence, IPC, query invalidation, or the editor
remount/session lifecycle.

1. **`apps/desktop/src/components/note-pane.tsx`** — `React.memo(NotePane)`.
   *Highest impact.* One `NotePane` mounts per visible day in the daily stream,
   each running four hooks. The stream re-renders on scroll (the virtualizer's
   visible-item set changes), settings changes, navigation, and the midnight
   `useToday` rollover — previously re-executing all four hooks for every visible
   day regardless of whether its props changed. All props are stable primitives
   or a `useCallback`'d `onAutoFocused`, so memo skips unchanged rows. The
   `key={document.sessionEpoch}` remount contract is unaffected (a `path` change
   makes props differ, so memo allows the re-render). Also benefits the mobile
   `day-carousel`.

2. **`apps/desktop/src/components/command-palette/command-palette.tsx`** —
   - stable `key="note-preview"` for `<NotePreview>` (was `key={selectedNote.path}`,
     which unmounted+remounted the entire preview subtree on every ↑/↓; the
     component holds no internal state and the query is path-keyed, so a stable
     key is safe);
   - `React.memo(Snippet)` so `parseHighlights` doesn't rerun for unchanged
     snippet strings on each palette keystroke.

3. **`apps/desktop/src/components/sidebar/sidebar-note-row.tsx`** —
   `React.memo(SidebarNoteRow)`. The sidebar re-renders on every route change;
   pinned rows no longer recompute `routeForPath`/`routesEqual` for unchanged
   props.

4. **`apps/desktop/src/components/context-sidebar/day-calendar.tsx`** —
   `useMemo` the noted-dates lookup `Set` (was allocated every render; the right
   sidebar re-renders as the focused day scrolls).

5. **`apps/desktop/src/lib/use-similar-notes.ts`** — `useMemo` the sliced
   result so consumers get a reference-stable array instead of a fresh one each
   render.

### New tests
- **`apps/desktop/src/lib/use-similar-notes.test.tsx`** — the result is
  reference-stable across re-renders, and the disabled path never queries.
- **`apps/desktop/src/components/sidebar/sidebar-note-row.test.tsx`** — the row
  does not re-render when the parent re-renders with identical props.

### Docs
- `docs/performance-pass-20260620/{plan,status,benchmarks,final-report}.md`

## Findings deliberately NOT taken (audited + rejected)

- **Debounce/coalesce the global `invalidateIndexQueries`.** The Rust watcher
  already debounces (~400 ms), so `onApplied` calls are already far apart on the
  typing path; a JS debounce adds staleness for no measurable gain.
- **Narrow index-invalidation scope** (split backlinks / conflicted-notes /
  duplicate-note-ids out of the global invalidation). These index projections
  legitimately change during ordinary editing — typing a conflict marker,
  editing a frontmatter `id`, or a *different* note's links changing this note's
  backlinks — so narrowing would surface stale data. The broad invalidation is
  correct; structural sharing already absorbs its render cost. (The IPC refetch
  cost remains, but every safe narrowing was unsound.)
- **`useCallback`-only fixes on non-memoized rows** (sidebar items, backlink
  groups, similar-notes rows) — no-ops without a memoized child or requiring
  `icon`/prop restructuring that adds complexity for a tiny surface.

## Verification commands & results

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | PASS (all packages) |
| Lint | `pnpm lint` | 0 errors, 5 warnings (all pre-existing, none in touched files) |
| Desktop build | `pnpm --filter @reflect/desktop build` | PASS (`vite build`, built in ~0.4s) |
| Tests | `pnpm vitest run` over command-palette, sidebar, context-sidebar, daily-stream, backlinks, + 2 new suites | **116/116 PASS** (15 files) |
| Whitespace/diff | `git diff --check origin/next...HEAD` | clean (exit 0) |

> Note: the root `pnpm test` is a turbo wrapper that does not forward file
> args; per-file tests run via `pnpm vitest run <path>` from `apps/desktop`.

## Real benchmark evidence

Automated render-count and timing benchmarks were run after the initial pass.
See **`docs/performance-pass-20260620/real-benchmarks.md`** for full methodology,
dataset description, reproduction commands, and result interpretation.

Raw Vitest output: `docs/performance-pass-20260620/artifacts/memoization-perf.txt`  
Benchmark harness: `apps/desktop/bench/memoization-perf.bench.test.tsx` (9/9 PASS)

Real before/after numbers (source files at `7225f2e` vs `1d08a2b`):

| Flow | Before (pre-memo) | After (memoized) |
|---|---|---|
| Daily-stream scroll — NotePane re-renders (50 days × 20 events) | **1 000** | **0** |
| Daily-stream — React Profiler `actualDuration` (20 events) | 90 ms | 26 ms (3.47×) |
| Palette typing — `parseHighlights` calls (50 results × 10 keys) | **500** | **0** |
| Palette ↓ nav — `NotePreview` remounts (15 arrow presses) | **15** | **0** |
| Sidebar route change — pinned-row re-renders (40 rows × 12 changes) | **480** | **0** |
| Calendar — `new Set` allocations (24 re-renders, stable data) | **24** | **0** |
| Similar notes — distinct array refs per 20 re-renders | **21** | **1** |

## Practical UI verification

The full Tauri app could not be launched (no Rust toolchain on this machine —
project memory). UI-affecting changes are pure render memoizations proven by the
automated benchmarks above and the new unit tests; the React DevTools Profiler
procedure to observe each interactively is in `benchmarks.md`.

## Remaining risks

| Risk | Likelihood | Notes |
|---|---|---|
| `React.memo` adds a shallow prop compare per row | Negligible | ~7 primitive props; far cheaper than the avoided hook/render work |
| Stable `NotePreview` key changes preview lifecycle | Low | Component is stateless; query is path-keyed; behavior identical, fewer mounts |
| Memo masks a future prop that *should* re-render | Low | All current props are value-stable; a new non-primitive prop would need a custom comparator (documented by the memo wrapper) |
| Global index invalidation still refetches all mounted index queries per batch | Known/accepted | Every safe narrowing was proven unsound; left intentionally for correctness |

## Remaining opportunities (out of scope here)

- Targeted index invalidation would require the index layer to emit *which*
  projections changed (not just which note paths), since backlinks of note X
  depend on other notes' outbound links. That is a core/IPC contract change, too
  broad and risky for this behavior-preserving pass.
