# Plan 06 — Daily Notes & Routing

**Goal:** Make the daily note the chronological spine: the app opens to today, capture
defaults to today, dates are navigable and linkable, and the app has a stable route
model. This completes **M1 — the first genuinely usable build.**

**Depends on:** Plan 04 (daily lookup/index), Plan 05 (editor).
**Unlocks:** Plan 07 (date links resolve here), 08 (date navigation commands), 11
(capture appends here).

## Scope

**In:** open-to-today, daily file create-on-demand, chronological navigation (prev/next/
infinite stream), `[[YYYY-MM-DD]]` date links, the route/app-state model, "go to daily
note" + "new note" keyboard paths.
**Out:** calendar/meeting context (deferred), templates (deferred — leave an insertion
seam).

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
   - `note/:id` (regular note)
   - `search/:query` (Plan 08)
   These are **product routes**, not page names. Back/forward (`⌘[` / `⌘]`) traverse a
   route history stack; focus + scroll position restore on navigation. Routes are the
   integration point for deep links / CLI "open" later.

   ```ts
   // src/lib/routing/route.ts
   export type Route =
     | { kind: 'today' }
     | { kind: 'daily'; date: string }
     | { kind: 'note'; id: string }
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
