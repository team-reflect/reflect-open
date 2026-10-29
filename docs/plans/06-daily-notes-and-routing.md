# Plan 06 — Daily Notes & Routing

**Goal:** Make the daily note the chronological spine: the app opens to today, capture
defaults to today, dates are navigable and linkable, and the app has a stable route
model. This completes **M1 — the first genuinely usable build.**

**Depends on:** Plan 04 (daily lookup/index), Plan 05 (editor).
**Unlocks:** Plan 07 (date links resolve here), 08 (date navigation commands), 11
(capture appends here).

**Libraries:** a **custom typed router** (no dependency), `date-fns` (dates/timezones),
`@tanstack/react-virtual` (daily stream). See [Libraries](libraries.md).

## Scope

**In:** open-to-today, daily file create-on-demand, chronological navigation (prev/next/
infinite stream), `[[YYYY-MM-DD]]` date links, the route/app-state model, "go to daily
note" + "new note" keyboard paths.
**Out:** calendar/meeting context (deferred), templates (deferred — leave an insertion
seam).

## Delivery split (decided 2026-06-09)

- **06a** — the spine: the typed route model + history router (step 4), the central
  date module, open-to-today with **lazy create-on-first-keystroke** (step 1),
  prev/today/next day navigation (single-day view), `[[YYYY-MM-DD]]` Mod+click
  navigation (step 3), and the `⌘D/⌘N/⌘[/⌘]` shortcuts through the keymap registry
  (step 5). The note route carries `path` (identity = path in the first wave, Plan 03;
  `id` joins later).
- **06b** — the virtualized daily stream + navigation polish (implemented in
  `apps/desktop/src/components/daily-stream.tsx` and the route history scroll API):

  1. **The stream (step 2).** A virtualized chronological list where **every day is a
     virtual note**: each row mounts the Plan 05 single-note editor (`NotePane` with
     `createIfMissing`) keyed by date — the file is only created when the day is
     actually edited (decided: dynamically create virtual day notes; materialize on
     edit). **Order is chronological** — past above, future below — anchored at today
     on launch, and the future is scrollable (future days are valid write targets).
  2. **Fixed virtual window, not true infinite scroll.** Window = `today − 5 years …
     today + 1 year` as a static count (~2.2k virtual rows — free until mounted),
     index ↔ date as pure offset math. This avoids bidirectional-prepend scroll
     compensation entirely; "load older" can extend the window later if ever needed.
     Dynamic row heights via `measureElement` (editors grow while typing); overscan
     ~2 so only a handful of ProseKit instances are live; offscreen days unmount and
     flush through the save pipeline's final-flush path (built in Plan 05).
  3. **Routes drive the stream.** `today` and `daily/:date` both render the stream
     scrolled to the target date; prev/next become scroll + `⌘` navigation rather
     than separate pages.
  4. **Scroll/focus restore (step 4 tail).** History entries become
     `{ route, scroll? }` with a `saveScrollState` API; views report their offset
     before navigating away; back/forward restores the offset and refocuses the
     target editor.
  5. **Indexing state surfaced (step 7).** Expose the background index stage
     (`reconciling` → `live`) from the graph-index lifecycle; subtle header
     indicator — product states, not spinners.

  **Deferred from 06b:** jot-to-today quick capture → **Plan 11** (decided
  2026-06-09; `⌘D` + typing covered the need until the capture pipeline landed).

  **Tests (headless):** window↔date math, router scroll-state semantics, lazy
  materialize-on-edit (exists), launch-focus. Stream scroll feel + height
  measurement need `tauri dev` (jsdom has no layout).

## Steps

1. **Today on launch.** On graph ready, resolve today's `daily/YYYY-MM-DD.md` (local
   timezone). If absent, create lazily on first keystroke (don't litter the graph with
   empty files for days never written). Land focus in the editor.

2. **Daily navigation.** Previous/next day via keyboard + UI. Provide a virtualized
   chronological stream (past/future days) as the daily view — but keep it backed by the
   single-note editor (Plan 05) per day to avoid a separate editor implementation. Because
   meowdown's `<Editor>` is uncontrolled (Plan 05), mount **one editor per day keyed by
   date** (`<Editor key={date} initialContent={...} />`) so each day owns its own instance;
   unload offscreen days. Future dates are valid write targets (lightweight scheduling),
   matching V1.

3. **Date links.** `[[2026-06-08]]` resolves to that daily note (create-on-demand if
   missing), via the resolution rules from Plan 03. ISO date links are the stable first
   contract; natural-language dates are deferred.

4. **Route model (designed with the data model, not bolted on).** Define typed,
   shareable app routes and a small router over them:
   - `today`
   - `daily/:date` (`YYYY-MM-DD`)
   - `note/:path` (regular note — path-as-identity, Plan 03; `id` joins later)
   - `search/:query` (Plan 08)
   These are **product routes**, not page names. Back/forward (`⌘[` / `⌘]`) traverse a
   route history stack; focus + scroll position restore on navigation. Routes are the
   integration point for deep links / CLI "open" later.

   ```ts
   // src/lib/routing/route.ts
   export type Route =
     | { kind: 'today' }
     | { kind: 'daily'; date: string }
     | { kind: 'note'; path: string }
     | { kind: 'search'; query: string }
   ```

5. **Core keyboard paths.** Wire into the Plan 05 keymap registry:
   `⌘D` go to today's daily note, `⌘N` new note, `⌘[ / ⌘]` back/forward. (`⌘K` reserved
   for Plan 08.) New notes get a ULID + readable filename (Plan 02) and open in the editor.

6. **Quick capture default.** A "jot to today" affordance (and the foundation for capture
   in Plan 11): appends text under the daily note without leaving the current context.

7. **Loading gate as product states.** Model app-ready as explicit states
   (`choosing-graph` → `indexing` → `ready`), not ad-hoc spinners, so onboarding (Plan 15)
   and error/repair (Plan 04) have clear seams. No auth/encryption/billing gates exist in
   V2 — keep this gate small.

## Key decisions / contracts

- **Today's note is created lazily**, on first write, not pre-created.
- **Routes are typed and shareable**, with a history stack powering back/forward and
  serving as the deep-link/CLI open target later.
- **The daily stream reuses the single-note editor** per day — no second editor.

## Acceptance criteria

- Launch lands on today's daily note (created on first keystroke) with editor focus.
- `⌘D`, `⌘N`, `⌘[`, `⌘]` work; back/forward restores scroll + focus.
- `[[2026-06-08]]` opens/creates that daily note.
- Navigating prev/next day works and stays fast on a large graph.
- `pnpm typecheck` + tests pass. **M1 demo:** write across several days, quit, reopen —
  notes are on disk as `daily/*.md` and indexed.

## Risks

- **Timezone/DST edge cases** for "today" and date parsing. Centralize date logic in one
  tested module; store ISO local dates.
- **Infinite stream performance.** Virtualize; lazy-mount per-day editors; unload
  offscreen days.
- **Lazy file creation vs links.** A `[[2026-06-09]]` link to a non-existent future
  daily must resolve gracefully (create-on-open), not error.
