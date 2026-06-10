# Daily context sidebar — plan

Add a contextual right-hand sidebar for the daily-note experience, filling the
`AppShell` sidebar slot that has been a placeholder since Plan 06. Product/UX
inspiration comes from the original Reflect app's note context sidebar.

## Old Reflect observations (read-only reference repo)

From `/Users/cloud/repos/team-reflect/reflect`:

- `components/note-context-sidebar/note-context-sidebar.tsx` (lines 16–40)
  stacks sections top-to-bottom: **calendar** (daily notes only), **note
  actions**, **public URL**, **suggest contact**, **events/meetings**
  (Google-credential-gated, daily only), **suggested backlinks**, **similar
  notes**.
- `components/sidebar-item/sidebar-item.tsx` — every section is a collapsible
  unit: title, chevron (hidden until hover), open/close state persisted in
  session storage per section key.
- `components/note-context-sidebar/note-calendar/` — month grid
  (`@veccu/react-calendar`), prev/next month chevrons, "today" affordance
  (⌘D), selected day highlighted, **dot markers on days that have a non-empty
  daily note** (`noteStore.hasNonEmptyNoteForDate`), configurable week start.
- `components/note-context-sidebar/note-meetings/note-meetings.tsx` — renders
  only with calendar credentials and on daily notes; hidden when empty.
- `components/note-context-sidebar/note-similar-notes/note-similar-notes.tsx`
  — up to 5 vector-search neighbors; section hidden when empty.
- `components/note-context-sidebar/note-suggested-backlinks/` — alias keyword
  matches with accept/ignore/add-all; only when the editor has focus.
- `components/note-incoming-backlinks/` — backlinks live *under the note*,
  not in the sidebar, with per-source grouping and snippets.
- `client/screens/main/main-shortcuts.tsx` — ⌘D jumps to today; no top-level
  sidebar toggle (sidebar is always present, sections collapse individually).

Takeaways: sections are individually gated by real data availability and
hidden when empty; the calendar is the daily-note anchor; everything is quiet,
compact, and list-shaped.

## Reflect Open layout/data opportunities

- `apps/desktop/src/components/app-shell.tsx:31-38` — right `aside` region
  already exists (`w-80`, hidden below `lg`); renders only when `sidebar` is
  passed. No new layout frame needed.
- `apps/desktop/src/components/graph-workspace.tsx:66-68` — currently passes a
  static `Context` placeholder for **all** routes; this is the wiring point.
- Typed routes (`apps/desktop/src/routing/route.ts`): `today`, `daily/:date`,
  `note`, `search`, `settings`. The daily stream anchors to
  `route.date` (validated by `isIsoDate`) or live `today`.
- Index data available today (`@reflect/core`):
  - `getBacklinksWithContext(path)` — backlinks + snippets (Plan 07).
  - `relatedNotes(path)` — semantic neighbors from stored vectors (Plan 09);
    returns `[]` when embeddings are off/not built.
  - `notes.dailyDate` column — can answer "which days in a range have a daily
    note" with a tiny new query; freshness rides the existing index
    invalidation scope (`INDEX_QUERY_SCOPE` + `invalidateIndexQueries`).
- Real keyboard shortcuts to hint: ⌘D = `nav.today`
  (`apps/desktop/src/lib/commands/app-commands.ts`).
- Design system: tokens (`--text-*`, `--accent`, `--accent-soft`, `--border`,
  `--surface-*`), Tailwind v4, lucide icons — match existing panels
  (`backlinks-panel.tsx`, `related-notes.tsx`).

## Selected MVP (this PR)

A `DailyContextSidebar` rendered in the `AppShell` sidebar slot **only on
`today` and `daily` routes**, describing the navigated day:

1. **Day header** — weekday/date label for the target day, "Today" badge.
2. **Calendar** — compact month grid: prev/next month, weekday header row,
   dot markers on days with an indexed daily note (new core query
   `dailyDatesInRange`), selected day + today highlighted, click to navigate
   to that day, "Today" button with real ⌘D hint. Week starts Monday.
3. **Linked from** — backlinks into the day's note via
   `getBacklinksWithContext(dailyPath(date))`, with count, snippets,
   click-to-navigate, and a graceful empty state.
4. **Related** — semantic neighbors via `relatedNotes(dailyPath(date))`;
   section hidden entirely when there are no vectors/results (old-app
   behavior — no misleading empty box when the feature is off).

Collapsible sections (`SidebarSection`) with per-section open state persisted
in session storage, mirroring old Reflect's `SidebarItem`.

### Deferred old-app features (not faked)

- **Events/meetings** — requires Google Calendar credentials/integration;
  Reflect Open has no credential store or calendar bridge. Follow-up.
- **Public URL / share / publish** — no publishing backend by design (no
  Reflect-hosted APIs). Out of scope.
- **Suggest contact** — CRM features don't exist here. Out of scope.
- **Note actions (pin/delete/history/export)** — no pin model or trash for
  daily notes in Reflect Open yet; old app hid delete for dailies anyway.
  Follow-up when those models exist.
- **Suggested backlinks (accept/ignore)** — needs ignored-suggestion
  persistence and editor insertion; `relatedNotes` covers discovery for now.

## Architecture

```
packages/core/src/indexing/queries.ts   + dailyDatesInRange(start, end)
apps/desktop/src/lib/month-grid.ts      pure month-grid/date helpers
apps/desktop/src/components/daily-sidebar/
  sidebar-route.ts                      dailySidebarDate(route, today) → date | null
  daily-context-sidebar.tsx             composition (header + sections)
  sidebar-section.tsx                   collapsible section primitive
  day-calendar.tsx                      month grid + day/today navigation
  day-backlinks.tsx                     "Linked from" section
  day-related-notes.tsx                 "Related" section (hidden when empty)
apps/desktop/src/components/graph-workspace.tsx   route → sidebar wiring
```

Notes:

- `dailySidebarDate` mirrors `RouteContent`'s anchoring exactly (malformed
  daily date ⇒ today; `note`/`search`/`settings` ⇒ no sidebar). `search`
  deliberately shows no sidebar: it's a modal palette over the stream and the
  sidebar would imply day context the user didn't navigate to.
- All index reads go through TanStack Query under `INDEX_QUERY_SCOPE` with the
  graph root in the key, matching `backlinks-panel.tsx` — freshness is
  event-driven via the existing invalidation hook.
- The sidebar lives outside the editor focus path; no keybindings are added or
  intercepted, so keyboard behavior is unchanged.

## Acceptance criteria

- `today` and `daily/:date` routes show the contextual sidebar in the app
  shell; `note`, `search`, and `settings` routes show none.
- Malformed `daily/:date` routes anchor the sidebar to today (same as the
  stream) instead of crashing.
- Calendar: navigates on day click, marks days with notes, prev/next month
  works across year boundaries, Today button returns to the `today` route,
  ⌘D hint matches the real binding.
- Backlinks section lists sources + snippets and navigates on click; shows a
  quiet empty state when the day has no inbound links.
- Related section appears only with real results.
- Empty/loading states are styled with design tokens; no mock data anywhere.
- Tests cover: route→sidebar-date contract, month-grid helpers,
  `dailyDatesInRange`, and sidebar rendering/navigation/empty states.

## Verification plan

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (vitest, targeted suites),
  `pnpm build`.
- UI: `pnpm tauri dev` if the native shell builds in this environment —
  inspect today route, navigate days via calendar, narrow the window below
  `lg` to confirm the sidebar yields to the editor. If Tauri can't run here,
  document the blocker and rely on jsdom tests + `pnpm dev` static review.
