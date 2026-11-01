# Porting the app shell and navigation

**v2 status: v1, shipped-in-progress.** The Daily/All tab shell, screens,
and settings exist under `apps/desktop/src/mobile/` (Plan 19 steps 3–4).
This doc records the V1 interaction details to measure parity against, and
what v2 deliberately changed.

## What V1 mobile does

### Shell

An Ionic tab shell (`client/core/router-tabs.tsx`) with three bottom tabs
and a floating action button:

- **Daily** (pencil) → `/:graph/daily/:id`, the default surface.
- **Tasks** (checkmark) → `/:graph/tasks`.
- **All** (list) → `/:graph/all`, with a detail stack (`/:graph/all/:id`),
  tag filters (`/:graph/all/tag/:tag`), and AI chat
  (`/:graph/all/ai-chat`) nested inside.
- **FAB** (`components/buttons/add-fab-button.tsx`), bottom-right: expands
  to **Create note** and **Record audio**. Hidden while the keyboard is up,
  in Tasks, and in AI chat.

Routing is Ionic React Router (react-router v5). `NavCapturing` (router →
`navigationView.pathname`) and `RouteToStoreSyncing` (URL graph param →
current graph) sync router and MobX state. Navigation intents live in
`client/models/ui/navigation-view.ts`; mobile UI state (recording modal,
focus requests, current tab) in `client/models/ui/mobile-view.ts`.

### Interaction details that make it feel native

- **Tab bar hides when the keyboard shows** (`useHideTabBar()` on the
  Capacitor Keyboard plugin), giving the editor the full viewport.
- **Double-tap a tab to scroll to top**; on Daily it also re-centers the
  calendar on today. Light haptic on every tab press (`lib/haptics.ts`).
- **Status-bar tap** scrolls the list to top (posted from
  `AppDelegate.touchesBegan`).
- **iOS swipe-back** on stacked screens (Ionic default transitions).
- **Wake to today**: on foreground, if the date changed, the app navigates
  to today's daily note.
- Every screen wraps `components/page/page.tsx`: sticky header with back
  button (detail views only), a profile button with a sync spinner badge, a
  tappable title, and per-screen actions.

### Boot gates

`client/core/loader.tsx` renders by `rootStore.loadingState`, in order:
Auth → SQLite migrating ("Preparing your notes…") → graph setup → graph
loading → encryption unlock → version-unsupported → initial sync ("Got X
notes" progress) → main tabs.

### Profile modal

The header avatar opens a card modal (`client/screens/profile/`):
avatar/email, graph switcher, note + recording counts, a settings subset
(font size, week start, date format, time format), JSON export,
recovery-kit creation, sign out, delete account.

## What changes in v2, and why

- **Two tabs, not three.** v2 ships **Daily / All**
  (`apps/desktop/src/mobile/mobile-shell.tsx`, `mobile-tab-bar.tsx`); Tasks
  is post-release (see [tasks](./tasks.md)). Screens render a subset of the
  typed `Route` union with no URL router, so the
  `NavCapturing`/`RouteToStoreSyncing` glue has no equivalent.
- **The capture FAB is compact.** One persistent `+` expands to **Create
  note** and **Record audio**, then collapses. Create note uses desktop's
  ⌘N seed/ghost-title flow; recording opens the native audio drawer.
- **Most boot gates vanish.** No auth, unlock, version gate, or Firestore
  sync. What remains: onboarding (`onboarding-screen.tsx`: Start fresh /
  Connect GitHub with device flow, clone, and initial index progress) and
  graph open.
- **Settings replaces the profile modal**
  (`apps/desktop/src/mobile/screens/settings.tsx`), in V1's avatar spot:
  graph name, storage kind, note count, GitHub connect/disconnect, sync
  status, version, and (since Plan 21) **Switch graph** (other
  iCloud-container graphs + the on-device root; one graph open at a time).
  No account rows, no JSON export (the workspace is already Files-visible
  markdown).

## Worth porting deliberately

Cheap V1 details that carry the native feel:

- Tab-bar hide on keyboard (from the `--keyboard-height` CSS variable set
  by `plugins/tauri-plugin-keyboard`).
- Double-tap tab → scroll to top (+ re-center Daily on today).
- ~~Light haptics on tab presses and date selection~~: done, via the haptics
  plugin's `impact_light` (`UIImpactFeedbackGenerator`) from
  `src/mobile/haptics.ts`.
- Wake to today on foreground date change.
- ~~Back-swipe and stack transitions on note detail~~: done.
  `src/mobile/mobile-stack.tsx` renders note screens as cards over their
  tab root (slide-in push, slide-out pop, instant tab switches) and
  `src/mobile/use-back-swipe.ts` is the edge back-swipe. Transform-based on
  purpose: the View Transitions API commits the DOM swap before animating,
  which would remount the editor on every canceled swipe.
- Status-bar tap → scroll to top, if reachable from the Tauri shell.

## V1 → v2 mapping

| V1                                          | v2                                                          |
| ------------------------------------------- | ------------------------------------------------------------ |
| Ionic tabs Daily / Tasks / All              | Daily / All tab shell; Tasks post-release                    |
| react-router v5 URLs (`/:graph/…`)          | Typed `Route` union subset, no URL router                    |
| FAB → create note / record                  | `+` speed dial → untitled note or native audio drawer        |
| Boot gates (auth/unlock/version/sync)       | Onboarding (fresh / GitHub clone) + graph open only          |
| Profile card modal                          | Settings sheet (graph, GitHub, sync status, version)         |
| Graph switcher                              | Shipped via Plan 21 — settings-sheet Switch graph across container graphs |
| `useHideTabBar` (Capacitor keyboard events) | `--keyboard-height` from the first-party keyboard plugin     |
| Sync spinner badge on the avatar            | Sync status pill / settings-sheet status ("Backed up …")     |
