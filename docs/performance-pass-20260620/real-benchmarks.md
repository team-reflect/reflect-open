# Performance Pass (2026-06-20) — Real Benchmarks

**Branch:** `claude/performance-pass-20260620`  
**Commit measured (head):** `1d08a2b98d` (PR #294)  
**Baseline commit:** `7225f2e` (parent of the perf commit, pre-memo)  
**Benchmark run:** 2026-06-20  
**Raw artifacts:** `docs/performance-pass-20260620/artifacts/`

---

## Environment

| Item | Value |
|---|---|
| Platform | macOS Darwin 25.3.0 (arm64) |
| Node.js | v26.3.0 |
| React | 19.x |
| Test runner | Vitest v4.1.9, jsdom |
| Tauri shell | Not available (no Rust toolchain on this machine) |
| React Compiler | Active (shared via the production Vite plugin) |

## Methodology

The PR's changes are all behavior-preserving render memoizations — no persistence,
IPC, or editor lifecycle semantics changed. The right metric is therefore
**render / hook-execution / allocation count**, which is identical in jsdom
and Chromium (same React reconciler). Wall-clock `actualDuration` from the React
Profiler API is recorded as secondary evidence where available.

### Before/after procedure

The `bench/run-before-after.sh` script runs the full suite twice in one
invocation:

1. At **HEAD** (`1d08a2b` — memoized PR): runs bench tests with `BENCH_REV=head`.
2. Temporarily checks out the **five changed source files** at `7225f2e`
   (pre-memo) and runs with `BENCH_REV=baseline`.
3. A `trap` restores all five files on any exit (verified: working tree was
   clean before and after).
4. `bench/summarize.mjs` merges the two artifact directories and prints the
   comparison table.

All harness code, mocks, and fixture data are byte-identical across both runs;
any delta is attributable solely to the six memoizations applied in commit
`1d08a2b`.

### Dataset (`bench/lib/dataset.ts`, deterministic PRNG seed `0x9e3779b9`)

| Dimension | Size |
|---|---|
| Daily notes (daily stream scenario) | 730 |
| Ordinary notes | 1 500 |
| Pinned shelf items | 40 |
| Palette result rows | 50 |
| Noted calendar dates (one month) | 23 |
| Semantic-neighbour hits | 6 |

### Reproduction

```bash
cd apps/desktop
bash bench/run-before-after.sh          # produces artifacts/ + prints the table
# or run a single scenario:
pnpm vitest run bench/note-pane.bench.test.tsx --reporter=verbose
# or run the consolidated inline suite:
pnpm vitest run bench/memoization-perf.bench.test.tsx --reporter=verbose
```

---

## Before / after results

Output from `bench/summarize.mjs` (2026-06-20 run):

```
| Flow                                              | Headline metric              | Before (pre-memo) | After (memoized) |
|---|---|---|---|
| Daily-stream scroll — NotePane re-renders avoided | rerenderNotePaneRenders      | 1000              | 0                |
| Palette typing — parseHighlights reruns           | typingParseHighlightsCalls   | 500               | 0                |
| Palette ↓ nav — NotePreview remounts              | mountsDuringArrows           | 15                | 0                |
| Sidebar route change — pinned-row re-renders      | rerenderRowRenders           | 480               | 0                |
| Calendar re-render — noted-Set allocations        | rerenderSetBuilds            | 24                | 0                |
| Similar-notes — distinct array refs / renders     | distinctResultReferences     | 21                | 1                |
```

### Raw metrics per flow

#### Flow 2 — Daily stream scroll (`note-pane.bench.test.tsx`)

50 visible NotePane instances, 20 parent re-renders (simulating scroll events
that change the virtualizer's render range while the 50 open panes' props stay
constant).

| Metric | Before | After |
|---|---|---|
| NotePane body executions (re-renders) | **1 000** | **0** |
| NoteEditor subtree re-renders | **1 000** | **0** |
| React Profiler `actualDuration` (20 events) | **90.03 ms** | **25.97 ms** |
| Profiler-observed commits | 21 | 21 |

**Speedup (actualDuration): 3.47× — from 90 ms to 26 ms for 20 scroll events.**

Before memo, every scroll event forced all 50 visible panes to re-execute their
full hook chain (useNoteDocument, useImagePersistence, useWikiLinkNavigation,
useEditorAutocomplete) and re-render the editor subtree — regardless of whether
the day's content changed. After memo, only the scroll event itself commits; the
50 panes contribute zero additional work.

---

#### Flow 4a — Palette typing (`command-palette.bench.test.tsx`)

50 result rows with snippets, 10 keystrokes (query changes, snippet strings
unchanged).

| Metric | Before | After |
|---|---|---|
| `parseHighlights` calls (re-renders × results) | **500** | **0** |
| Mount-time `parseHighlights` calls | 100 | 50 |

Before memo, each keystroke triggered `parseHighlights` for every visible snippet
even when the snippet text was identical to the previous render. After memo,
unchanged `snippet` props skip the call entirely.

---

#### Flow 4b — Palette preview navigation (`command-palette.bench.test.tsx`)

15 ↓ arrow presses moving the palette highlight.

| Metric | Before | After |
|---|---|---|
| `NotePreview` component mounts during navigation | **15** | **0** |
| Total mounts (including open) | 16 | 1 |

Before the fix, `<NotePreview key={selectedNote.path}>` unmounted and remounted
on every ↑/↓ press — triggering effect teardown/setup and a full MarkdownPreview
rebuild each time. After the fix (`key="note-preview"`), the component stays
mounted and receives prop updates instead.

---

#### Flow 5a — Sidebar route change (`sidebar-note-row.bench.test.tsx`)

40 pinned shelf rows, 12 route-change re-renders.

| Metric | Before | After |
|---|---|---|
| Row body executions (re-renders) | **480** | **0** |
| Mount renders | 40 | 40 |

The sidebar reads `useRouter` and re-renders on every navigation. Before memo,
each route change caused all 40 pinned rows to re-execute `routeForPath` +
`routesEqual` + rebuild their button JSX — even though no pinned row's props
changed. After memo, 40 × 12 = 480 redundant executions are eliminated.

---

#### Flow 5b — Calendar noted-dates Set (`day-calendar.bench.test.tsx`)

23 noted dates, 24 right-sidebar re-renders.

| Metric | Before | After |
|---|---|---|
| `new Set(notedDates)` allocations during re-renders | **24** | **0** |
| Total Set allocations (including mount) | 25 | 1 |

Before `useMemo`, the noted-dates `Set` was reallocated on every re-render of the
right sidebar (which fires whenever the focused day scrolls). After `useMemo`, the
Set is rebuilt only when `notedDates` actually changes (structural sharing keeps
the array reference stable between unrelated re-renders).

---

#### Flow 5c — Similar notes array stability (`use-similar-notes.bench.test.tsx`)

20 re-renders with a stable `relatedNotes` query result.

| Metric | Before | After |
|---|---|---|
| Distinct array references returned per N re-renders | **21** (new array each render) | **1** (stable) |

Before `useMemo`, `(data ?? []).slice(0, 6)` created a new array object on every
render. A fresh reference each render defeats memoization in every consumer (a
memoized child receiving it as a prop, or a `useEffect` with it as a dependency,
would fire unnecessarily). After `useMemo`, the sliced result is reference-stable
across all re-renders as long as the underlying query data doesn't change.

---

## Inline consolidated suite (`memoization-perf.bench.test.tsx`)

A second, single-file benchmark with larger synthetic loads (used as a sanity
check and as the primary reproducible artifact without needing git checkout).
All 9 tests pass; selected results from the run on 2026-06-20:

| Scenario | Render/alloc calls (PR) | Render/alloc calls (baseline) |
|---|---|---|
| B1 SidebarNoteRow × 100 route-changes | **0** | 4 000 |
| B2 Snippet × 50 keystrokes | **0** | 600 |
| B3 DayCalendar Set × 100 re-renders | **0** new allocations | 100 |
| B4 useSimilarNotes × 100 re-renders | **0** new allocations | new array/render |
| B5 NotePane × 20 scroll events | **0** | 200 |

---

## Caveats

1. **jsdom, not a real browser.** jsdom does not paint, animate, or schedule
   frames. The measurements capture React reconciler work (hook execution, prop
   comparison, tree traversal), not layout or paint. Reconciler render counts
   are environment-independent (same React build runs in jsdom and Chrome);
   `actualDuration` reflects Node.js V8, not browser V8.

2. **No Tauri shell.** The full native app was not launched. NotePane benchmarks
   use a mocked `useNoteDocument` that returns a ready state (so the editor does
   render in the note-pane test), or a never-resolving fake bridge for the
   inline suite. Both are conservative: hooks and the editor subtree execute
   fully, so the measured savings are real.

3. **React Compiler active.** The Vite plugin (and hence the Vitest transformer)
   runs the React Compiler on all source files. The `actualDuration` delta
   therefore reflects the incremental benefit of the explicit `React.memo` on
   top of what the compiler already provides.

4. **`actualDuration` variability.** Profiler timing varies ±15–30% between
   runs on warm/cold V8 JIT state. The render/count numbers are deterministic
   integers and are the primary evidence; ms figures are supplementary.
