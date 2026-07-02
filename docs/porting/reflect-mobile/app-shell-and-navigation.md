# Porting the app shell and navigation

**v2 status: v1, shipped-in-progress.** The Daily/All tab shell, screens,
and settings sheet exist under `apps/desktop/src/mobile/` (Plan 19 steps
3–4). This doc records the V1 interaction details parity should be
measured against, and the pieces v2 deliberately changed.

## What V1 mobile does

### Shell

The app is an Ionic tab shell (`client/core/router-tabs.tsx`) with three
bottom tabs and a floating action button:

- **Daily** (pencil icon) → `/:graph/daily/:id` — the default surface.
- **Tasks** (checkmark icon) → `/:graph/tasks`.
- **All** (list icon) → `/:graph/all`, with a detail stack
  (`/:graph/all/:id`), tag filters (`/:graph/all/tag/:tag`), and the AI
  chat page (`/:graph/all/ai-chat`) nested inside it.
- **FAB** (`components/buttons/add-fab-button.tsx`), bottom-right: expands
  to **Create note** and **Record audio**. Hidden while the keyboard is
  up, in the Tasks tab, and in AI chat.

Routing is Ionic React Router (react-router v5). Two glue components sync
router and MobX state: `NavCapturing` (router → `navigationView.pathname`)
and `RouteToStoreSyncing` (URL graph param → current graph). Navigation
intents live in `client/models/ui/navigation-view.ts`; mobile UI state
(recording modal, focus requests, current tab) in
`client/models/ui/mobile-view.ts`.

### Interaction details that make it feel native

- **Tab bar hides when the keyboard shows** (`useHideTabBar()` listening
  to the Capacitor Keyboard plugin) — the editor gets the full viewport.
- **Double-tap a tab to scroll to top**; on Daily it also re-centers the
  calendar on today. Light haptic on every tab press (`lib/haptics.ts`).
- **Status-bar tap** scrolls the current list to top (notification posted
  from `AppDelegate.touchesBegan`).
- **iOS swipe-back** works on stacked screens (Ionic default transitions:
  slide-in push, slide-out pop, card-modal dismiss).
- **Wake to today**: on foreground, if the date changed while
  backgrounded, the app re-navigates to today's daily note.
- Every screen wraps a shared `Page` component
  (`components/page/page.tsx`): sticky header with back button (detail
  views only), a profile button with a sync spinner badge, a tappable
  title, and per-screen action buttons.

### Boot gates

`client/core/loader.tsx` renders by `rootStore.loadingState`, in order:
Auth → SQLite migrating ("Preparing your notes…") → graph setup → graph
loading → encryption unlock → version-unsupported → initial sync (with
"Got X notes" progress) → main tabs.

### Profile modal

The header avatar opens a card modal (`client/screens/profile/`), not a
screen: avatar/email, graph switcher, note + recording counts, a small
settings subset (font size, week start, date format, time format), JSON
export, recovery-kit creation, sign out, delete account.

## What changes in v2, and why

- **Two tabs, not three.** v2 ships a **Daily / All** shell
  (`apps/desktop/src/mobile/mobile-shell.tsx`, `mobile-tab-bar.tsx`);
  Tasks is post-release (see [tasks](./tasks.md)). Screens render over a
  subset of the typed `Route` union — no URL router at all, so the
  `NavCapturing`/`RouteToStoreSyncing` glue has no equivalent.
- **No FAB menu.** Per the 2026-06-12 product call the daily note *is*
  the capture surface; a single `+` button opens a fresh untitled note via
  desktop's ⌘N seed/ghost-title flow. Record moves to the audio wave.
- **Most boot gates vanish.** No auth, no encryption unlock, no version
  gate, no Firestore initial sync. What remains: onboarding
  (`onboarding-screen.tsx`: Start fresh / Connect GitHub with device flow,
  clone, and initial index progress) and graph open.
- **Settings sheet replaces the profile modal**
  (`apps/desktop/src/mobile/settings-sheet.tsx`), in V1's avatar spot:
  graph name, note count, GitHub connect/disconnect, sync status, version.
  No graph switcher (one graph per device in v1), no account rows, no JSON
  export (the workspace is already Files-app-visible markdown).

## Worth porting deliberately

Cheap, load-bearing-for-feel V1 details to carry into the v2 shell where
not already present:

- Tab-bar hide on keyboard (drive it from the `--keyboard-height` CSS
  variable set by `plugins/tauri-plugin-keyboard`).
- Double-tap-tab → scroll-to-top (+ re-center Daily on today).
- ~~Light haptics on tab presses and date selection~~ — done: the keyboard
  plugin's `impact_light` command (`UIImpactFeedbackGenerator`), fired from
  `src/mobile/haptics.ts` in the tab bar and the calendar strip.
- Wake-to-today on foreground date change.
- Back-swipe and stack transitions on the note detail screen.
- Status-bar-tap scroll-to-top, if reachable from the Tauri shell.

## V1 → v2 mapping

| V1                                          | v2                                                          |
| ------------------------------------------- | ------------------------------------------------------------ |
| Ionic tabs Daily / Tasks / All              | Daily / All tab shell; Tasks post-release                    |
| react-router v5 URLs (`/:graph/…`)          | Typed `Route` union subset, no URL router                    |
| FAB → create note / record                  | `+` button → untitled note; record arrives with audio wave   |
| Boot gates (auth/unlock/version/sync)       | Onboarding (fresh / GitHub clone) + graph open only          |
| Profile card modal                          | Settings sheet (graph, GitHub, sync status, version)         |
| Graph switcher                              | Dropped in v1 — one graph per device                         |
| `useHideTabBar` (Capacitor keyboard events) | `--keyboard-height` from the first-party keyboard plugin     |
| Sync spinner badge on the avatar            | Sync status pill / settings-sheet status ("Backed up …")     |
