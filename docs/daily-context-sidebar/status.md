# Daily context sidebar — status

Updated: 2026-06-09

## Done

- Surveyed old Reflect's `note-context-sidebar` (calendar, actions, meetings,
  suggested backlinks, similar notes, `SidebarItem` collapsibles) and mapped
  it against Reflect Open's layout/data — see `plan.md`.
- Core: `dailyDatesInRange(start, end)` query over `notes.dailyDate`
  (`packages/core/src/indexing/queries.ts`), exported through
  `indexing/index.ts` and the package root; covered by
  `queries.test.ts` against the fake IPC bridge.
- Desktop helpers: `lib/month-grid.ts` (Monday-first full-week grids,
  month math, weekday labels) and
  `components/daily-sidebar/sidebar-route.ts` (`dailySidebarDate` route →
  sidebar-day contract).
- Sidebar components under `components/daily-sidebar/`:
  `daily-context-sidebar.tsx` (header with adjacent-day nav, Today badge /
  "Go to today" with the real ⌘D hint), `day-calendar.tsx` (month grid, note
  dots, day navigation), `day-backlinks.tsx` ("Linked from" with
  loading/error/empty states), `day-related-notes.tsx` (hidden when no
  results), `sidebar-section.tsx` (collapsible, session-persisted).
- Wired into `graph-workspace.tsx`: daily routes render the sidebar in the
  existing `AppShell` right region; note/search/settings render none.
- Tests: 23 new desktop tests + 2 core tests, all passing.

## Verification

- `pnpm typecheck` — pass (core, db, desktop).
- `pnpm lint` — pass (oxlint, no findings).
- `pnpm test` — pass: desktop 34 files / 210 tests (23 new), core suite
  including the new `queries.test.ts`.
- `pnpm build` — pass (pre-existing >500 kB chunk warning only).
- Native UI run blocked: `pnpm tauri dev` needs a cold Rust build plus a
  native file-dialog interaction to open a graph, neither drivable headlessly
  in this environment; a plain-browser `pnpm dev` has no IPC bridge, so the
  workspace (and sidebar) can't mount. Covered instead by jsdom component
  tests; the sidebar reuses the `AppShell` region that already collapses
  below the `lg` breakpoint, so narrow viewports keep the editor full-width.

## Next

- Final report, commit, push, PR against `master`.
