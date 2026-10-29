# Plan 06 — Daily Notes & Routing

**Goal:** Make the daily note the chronological spine: the app opens to today, capture
defaults to today, dates are navigable and linkable, and the app has a stable route
model. Completes **M1, the first usable build.**

**Depends on:** Plan 04 (daily lookup/index), Plan 05 (editor).
**Unlocks:** Plan 07 (date links), 08 (date navigation commands), 11 (capture appends here).

**Libraries:** custom typed router (no dependency), `date-fns`, `@tanstack/react-virtual`.
See [Libraries](libraries.md).

## Scope

**In:** open-to-today, daily file create-on-demand, chronological navigation,
`[[YYYY-MM-DD]]` date links, the route/app-state model, "go to daily" + "new note" keys.
**Out:** calendar/meeting context, templates (leave an insertion seam).

## Delivery split (decided 2026-06-09)

- **06a** — the spine: typed route model + history router, central date module,
  open-to-today with **lazy create-on-first-keystroke**, prev/today/next single-day view,
  `[[YYYY-MM-DD]]` Mod+click navigation, `⌘D/⌘N/⌘[/⌘]` via the keymap registry. The note
  route carries `path` (identity = path in the first wave; `id` joins later).
- **06b** — the virtualized daily stream (`apps/desktop/src/components/daily-stream.tsx`)
  + navigation polish:
  1. **Every day is a virtual note.** Each row mounts the Plan 05 `NotePane` with
     `createIfMissing`, keyed by date; the file materializes only on edit. Past above,
     future below, anchored at today; future days are valid write targets.
  2. **Fixed window, not infinite scroll.** `today − 5 years … today + 1 year` (~2.2k
     rows, free until mounted), index ↔ date as pure offset math. This avoids
     bidirectional-prepend scroll compensation; the window can grow later. Dynamic heights
     via `measureElement`; overscan ~2 so few ProseKit instances are live; offscreen days
     unmount and flush through Plan 05's final-flush path.
  3. **Routes drive the stream.** `today` and `daily/:date` render the stream scrolled to
     the date; prev/next become scroll + `⌘` navigation.
  4. **Scroll/focus restore.** History entries are `{ route, scroll? }` with
     `saveScrollState`; back/forward restores offset and refocuses the editor.
  5. **Indexing state surfaced** (`reconciling` → `live`) as a subtle header indicator,
     not a spinner.

  **Deferred:** jot-to-today quick capture → **Plan 11** (`⌘D` + typing covered it).

  **Tests (headless):** window↔date math, router scroll state, lazy materialize, launch
  focus. Scroll feel and height measurement need `tauri dev` (jsdom has no layout).

## Steps

1. **Today on launch.** Resolve today's `daily/YYYY-MM-DD.md` (local timezone). Create
   lazily on first keystroke so the graph has no empty files. Focus the editor.
2. **Daily navigation.** Prev/next via keyboard + UI, plus the stream. meowdown's
   `<Editor>` is uncontrolled, so mount **one editor per day keyed by date** and unload
   offscreen days. This reuses the single-note editor instead of a second implementation.
3. **Date links.** `[[2026-06-08]]` resolves to that daily (create-on-demand) via Plan 03
   rules. ISO links are the stable contract; natural-language dates are deferred.
4. **Route model**, designed with the data model: `today`, `daily/:date`, `note/:path`,
   `search/:query` (Plan 08). These are **product routes**, not page names. `⌘[`/`⌘]`
   traverse a history stack. Routes are the integration point for deep links / CLI "open".

   ```ts
   export type Route =
     | { kind: 'today' }
     | { kind: 'daily'; date: string }
     | { kind: 'note'; path: string }
     | { kind: 'search'; query: string }
   ```

5. **Keyboard paths.** `⌘D` today, `⌘N` new note (ULID + readable filename, Plan 02),
   `⌘[`/`⌘]` back/forward. `⌘K` is reserved for Plan 08.
6. **Quick capture default.** "Jot to today" appends under the daily without leaving the
   current context (foundation for Plan 11).
7. **Loading gate as product states** (`choosing-graph` → `indexing` → `ready`), so
   onboarding (Plan 15) and repair (Plan 04) have seams. V2 has no auth/billing gates;
   keep it small.

## Key decisions / contracts

- **Today's note is created lazily**, on first write.
- **Routes are typed and shareable**; the history stack powers back/forward and is the
  deep-link/CLI target.
- **The daily stream reuses the single-note editor** per day.

## Acceptance criteria

- Launch lands on today's daily (created on first keystroke) with editor focus.
- `⌘D`, `⌘N`, `⌘[`, `⌘]` work; back/forward restores scroll + focus.
- `[[2026-06-08]]` opens/creates that daily.
- Prev/next stays fast on a large graph.
- **M1 demo:** write across several days, quit, reopen; notes are on disk as
  `daily/*.md` and indexed.

## Risks

- **Timezone/DST edge cases.** Centralize date logic in one tested module; store ISO
  local dates.
- **Stream performance.** Virtualize; lazy-mount editors; unload offscreen days.
- **Lazy creation vs links.** A link to a non-existent future daily must create-on-open,
  not error.
