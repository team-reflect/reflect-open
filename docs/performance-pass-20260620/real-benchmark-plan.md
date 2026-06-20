# Real Benchmark Plan — Performance Pass (2026-06-20)

Goal: replace the theory-only `benchmarks.md` with **real, reproducible,
before/after** measurement evidence for PR #294's memoizations, run against the
actual components with a realistic large dataset.

## Constraints that shape the method

- **Tauri shell is not browser-automatable on macOS.** Tauri uses WKWebView on
  macOS, which CDP/Playwright/Chrome cannot attach to. So "drive the real app
  in a real browser" is impossible for the *shell*; the faithful automatable
  surface is the Vite/React frontend in real Chromium.
- **The data layer is SQL-over-IPC (`db_query`).** Every index read
  (`relatedNotes`, `dailyDatesInRange`, backlinks, palette search, note reads)
  ultimately calls `invoke('db_query', { sql, params })` against the native
  SQLite index. Booting the *full* app in a plain browser would require
  reimplementing the entire native SQLite-over-IPC backend — out of scope. (A
  Rust toolchain is now present, but a first `tauri build` + a non-automatable
  WKWebView still wouldn't yield browser-driven numbers.)
- **The change under test is render churn.** All six edits are behavior-
  preserving `React.memo`/`useMemo`. Their effect is **renders/commits avoided**
  and **allocations/remounts avoided** — not a behavior delta. The right primary
  metric is therefore **render/commit counts**, which are a property of React's
  reconciler and are **identical in jsdom and in Chromium** (same React build,
  same bail-out logic). Wall-clock is a noisy secondary signal for micro-memos.

## Two-tier measurement

### Tier 1 — Deterministic render/commit benchmark (primary, before/after)

A `*.bench.test.tsx` suite (Vitest, real `react-dom`) that, per flow:

1. Generates a **large dataset** (≈730 daily notes over 2y, ≈1,500 ordinary
   notes, links/backlinks, pinned shelf, noted-date calendar set, palette search
   results) once, shared across flows.
2. Mounts the **real affected component** wrapped in a React `<Profiler>`, with
   only the heavy *leaves* and *data providers* stubbed at the module boundary
   (the same pattern the repo's own `daily-stream.test.tsx` uses): the editor
   (`NoteEditor`), the four note-document hooks, and `useGraph`/`useSettings`/
   `useRouter` return fixtures. The component whose memoization is measured is
   always the real file.
3. Drives the real high-frequency interaction (stream re-render on scroll,
   palette ↑/↓ + typing, sidebar route change, calendar focus churn).
4. Records, via the Profiler `onRender` callback + injected render counters:
   **commit count**, **profiled-subtree render count**, **child mount/unmount
   count** (palette preview), **derived-reference-stability count** (calendar
   Set / similar-notes array), and **summed `actualDuration`**.
5. Writes machine-readable results to `docs/performance-pass-20260620/artifacts/`.

The whole suite is run twice — once with the working tree at **parent commit
`7225f2e`** (pre-memo) and once at **HEAD** (`1d08a2b`, memoized) — by checking
out just the six changed component files. The harness/dataset is byte-identical
across both runs, so the delta is attributable solely to the memoizations.

Why this is "real": real React reconciler, real component code, real query
client, realistic dataset size. Render counts are the exact quantity the memos
change and are environment-independent.

### Tier 2 — Real Chromium wall-clock (corroboration, low-IPC flows)

A Vite-served harness page (`bench/`) that mounts the **real command-palette and
sidebar/calendar components** (the flows whose data needs are small enough to
serve from an in-memory fake bridge) under a React `<Profiler>`, driven in **real
Google Chrome** via the browser automation tool. Captures, across many
iterations: `performance.now()` interaction latency, summed Profiler
`actualDuration`, and `PerformanceObserver` long-task counts. Run before/after
like Tier 1. This corroborates Tier 1's counts with genuine Chromium V8 timing
for the flows where a real-browser mount is tractable.

Flows that cannot get Tier-2 coverage (daily-stream + real editor, app cold
load) are reported from Tier 1 only, with the reason stated.

## Flows measured (maps to the brief's 5)

| # | Brief flow | Component(s) | Tier 1 | Tier 2 |
|---|---|---|---|---|
| 1 | Open app to daily note | NotePane mount in stream | ✓ (mount cost) | — (editor/IPC) |
| 2 | Scroll daily stream | `NotePane` memo in a re-rendering stream | ✓ | — (editor/IPC) |
| 3 | Open/switch notes | NotePane path-change remount contract | ✓ | — |
| 4 | Command palette search/preview nav | `Snippet` memo + stable `NotePreview` key | ✓ | ✓ |
| 5 | Sidebar/context panes | `SidebarNoteRow` memo, `DayCalendar` Set, `useSimilarNotes` | ✓ | ✓ |

## Instrumentation hygiene

All benchmark code lives under `apps/desktop/bench/` and in `*.bench.test.tsx`
files. **No production source file is modified.** Render counters are injected
by the harness (stub components / Profiler callbacks), never by editing the
components under test.

## Acceptance criteria

- Real before/after numbers for every flow that is feasible, with raw artifacts.
- Exact reproduction commands documented.
- Honest caveats: what is deterministic (counts) vs noisy (ms), and what could
  not be measured in a real browser and why.
- No production code touched; typecheck/lint/build/tests still green.
- `real-benchmarks.md` written; `final-report.md` updated; pushed to PR #294.

## Failure behavior

If a flow cannot be measured, state exactly why in `real-benchmarks.md` and
report what *was* measured. Never invent numbers.
