# Plan 22 — Mobile GitHub Connect (iOS)

**Goal:** the "This device" (local) graph on iOS can connect to a GitHub backup
repository, giving phone ↔ desktop sync for users without iCloud. The sync
machinery already runs on mobile — the backup controller mounts, background
flush fires on app-background, and Settings shows status and Disconnect. What's
missing is only the front door: sign in to GitHub and pick/create a repo from
the phone. This plan builds that connect flow and nothing else; **no new sync
mechanism, no engine changes.**

**Depends on:** Plan 12 (backup controller, merge machinery),
Plan 19/PR #483 (SyncProvider mounted in the mobile tree, mobile quit-flush),
Plan 21 (contract 5: iCloud sync and a Git remote are mutually exclusive per
graph — which makes the local graph precisely the one allowed a remote).
**Status:** implemented (Phases 0–3): the wizard hook extraction
(`use-connect-github-wizard.ts`, dialog tests passing untouched), the
`ConnectGithubDrawer` sheet, the Settings entry point, the copy changes, and
the jsdom + `?platform=ios` harness coverage. Remaining: the Phase 0
device spikes (clipboard, background-resume poll, keychain round-trip) and
the four-item manual device pass — both need a phone/simulator build.

**Explicitly not in scope:** GitHub connect for iCloud graphs (contract 5);
sync for the local graph via any non-Git mechanism; a mobile restore-from-repo
onboarding path (the phone joins an existing repo through the same connect
flow — a dedicated "restore" wizard can come later); Android; SSH remotes on
mobile (Plan 16's agent-auth transport has no phone story).

## Where we stand

**What already exists (and is reused unchanged):**

- **Engine + lifecycle.** `SyncProvider` is mounted in the mobile tree
  (`apps/desktop/src/mobile/mobile-app.tsx`), one backup controller per
  (graph, index session), launch pull, resume/online triggers, and the
  quit-flush leg. `connectNewRepo` / `connectExistingRepo` /
  `disconnectGraph` / `signOut` are already exposed through `useSync()`
  (`apps/desktop/src/providers/sync-provider.tsx`,
  `apps/desktop/src/lib/backup-controller.ts`).
- **Rust.** The `git` module (git2, vendored libssh2/openssl) already builds
  for iOS — PR #483 shipped it. Credentials go through `secrets.rs` on
  `keyring` with the `apple-native` feature, which backs onto the iOS
  keychain as well as the macOS one.
- **Core auth.** `runDeviceFlow` (poll policy included),
  `saveGithubAuth`/`loadGithubAuth`, `createGithubRepo`/`getGithubRepo` —
  all platform-neutral TS in `@reflect/core`. The device flow is *always*
  configured: `GITHUB_APP_CLIENT_ID` is a hardcoded constant in
  `packages/core/src/sync/github-auth.ts`, not a build-time env var, so iOS
  builds need no injection.
- **Transport (verified, not assumed).** GitHub calls ride `providerFetch` →
  `tauri-plugin-http`, so requests leave from the Rust side and webview CORS
  never applies — which matters because GitHub's device-flow token endpoints
  send no CORS headers. The plugin registers unconditionally
  (`src-tauri/src/lib.rs:105`, outside every `#[cfg(desktop)]` block), and
  `capabilities/default.json` has no `platforms` filter, so its http scope
  (`github.com/login/device/code`, `login/oauth/access_token`,
  `api.github.com/*`) and the opener grant already apply on iOS.
- **Desktop UI to mine.** `GithubAuthStep`
  (`apps/desktop/src/components/settings/github-auth-step.tsx`) is already
  written as the shared sign-in step (device flow leading, PAT fallback,
  single-shot completion, verified via `GET /user`). `ConnectGithubDialog`
  (`connect-github-dialog.tsx`) holds the full wizard: repo step → auth →
  finish, with the create-handoff poll, the grant-access step for App
  installs, and the public-repo consent gate.
- **Mobile UI substrate.** The inset-grouped settings primitives
  (`apps/desktop/src/mobile/settings-list.tsx`), the vaul bottom-sheet Drawer
  idiom (`apps/desktop/src/mobile/new-graph-drawer.tsx` is the model), and
  `useMobileSyncStatus` + the Backup group already in
  `apps/desktop/src/mobile/screens/settings.tsx` (status + Disconnect; it
  renders only when connected today).

**The gap:** no mobile surface calls `GithubAuthStep` or the connect methods.
The Backup group is invisible for a disconnected local graph, and the
`settings.tsx` docstring still claims "connecting happens in onboarding" — a
leftover from the pre-iCloud mobile onboarding that no longer exists.

## Contracts

1. **Local graphs only.** The connect entry point renders only when
   `mobileStorageKind === 'local'` and the backup phase is `disconnected`.
   iCloud graphs never see it (Plan 21 contract 5). The gate is the storage
   kind, not a root-path sniff.
2. **One wizard, two shells.** The connect state machine is extracted from
   `ConnectGithubDialog` into a hook; desktop's Dialog and mobile's Drawer
   are thin renderings of the same hook. No forked flow logic.
3. **Same safety gates as desktop.** Public-repo consent stays an explicit
   destructive-styled confirmation; the grant-access step steers to
   "Only select repositories"; a failed connect always offers a way back to
   the repo step.
4. **The phone joins, it does not fork.** Connecting an existing repo aligns
   the local branch with the repo's default branch (existing
   `connectExistingRepo` behavior) and the launch pull merges local content
   through the Plan 12 machinery — the near-empty phone graph (a seeded daily
   note at most) merges into desktop history, never the reverse.

## Phase 0 — extraction + spikes

- **Extract `use-connect-github-wizard.ts`** (new,
  `apps/desktop/src/hooks/`): steps (`repo`/`auth`/`finish`), create-vs-existing
  mode, target-ref resolution from the verified user, `finish()` with the
  public-confirm / create-guide / grant-access branches, and the
  existence/access poll. `ConnectGithubDialog` becomes a shell over the hook
  with **zero behavior change** — its existing tests
  (`connect-github-dialog.test.tsx`) must pass untouched, which is the
  refactor's acceptance test. Scope notes: `GithubAuthStep` has exactly one
  consumer today (the dialog — its docstring's "restore dialog" is
  aspirational), so the extraction touches one call site; `useRestoreFocus`
  is desktop-Dialog furniture and stays in the shell, not the hook.
- **Spike: device flow in WKWebView.** Three things to prove on a simulator
  + device before UI work:
  1. `navigator.clipboard.writeText` inside a tap handler (the copy-before-
     open step). Tauri iOS serves the app over a custom scheme, and the
     async clipboard API may be absent outside a browser-blessed secure
     context. The `copyState === 'failed'` manual-copy fallback already
     exists; if the API is missing, decide between touch-friendlier
     fallback copy (long-press-select the code) and adding
     `tauri-plugin-clipboard-manager` — prefer whichever is smaller.
  2. `openUrl` → Safari → return-to-app: the JS poll inside `runDeviceFlow`
     suspends while backgrounded and must simply resume and succeed on
     foreground (GitHub device codes live ~15 min; `slow_down` handling
     already exists in core). No code change expected — this is a
     verify-don't-assume item.
  3. `keyring`/`secrets.rs` round-trip on iOS (save + load a dummy entry) —
     `apple-native` should cover it, but it has never run on the phone.

  (A fourth unknown — whether GitHub API/device-flow requests can leave the
  app at all — was checked during planning and is settled: see *Transport*
  above.)

## Phase 1 — the mobile connect surface

- **`apps/desktop/src/mobile/connect-github-drawer.tsx`** (new): a vaul
  Drawer in the `NewGraphDrawer` idiom driving the wizard hook.
  - *Repo step:* segmented create-new (name input) vs use-existing
    (`owner/name` input, `parseRepoInput`). **Do not feed the graph name
    into `suggestRepoName` here:** the local graph's display name is the
    sandbox folder's basename — literally "Documents" — so desktop's
    `suggestRepoName(graph?.name)` would suggest `documents-backup`. Mobile
    passes no name and takes the `reflect-backup` fallback.
  - *Auth step:* reuse `GithubAuthStep` as-is — it is deliberately
    surface-agnostic (device flow + PAT fallback). Touch-specific styling
    tweaks only if something actually breaks in the sheet.
  - *Finish step:* connecting spinner, and the three parked states from the
    hook (public-confirm with destructive confirm, create-guide with
    "Create on GitHub…" handoff + poll, grant-access with the
    only-select-repositories steer + poll).
- **Settings entry point** (`apps/desktop/src/mobile/screens/settings.tsx`):
  render the Backup group for local graphs even when disconnected, with a
  `SettingsActionRow` "Connect GitHub" opening the drawer. Today the group
  is genuinely invisible in that state — `mobileSyncStatus` returns `null`
  for every non-`connected` phase, so both `repo` and `status` are null.
  Mind the `loading` phase: show the row disabled (or nothing) until the
  controller reports `disconnected`, so the row never flashes on a graph
  that turns out to be connected. Connected state keeps today's rows (repo,
  status, Disconnect). iCloud graphs keep today's behavior exactly (group
  appears only with status to show). Fix the stale "connecting happens in
  onboarding" docstring while there.
- **Gating:** `mobileStorageKind` comes from `useGraph()` — no new plumbing.
- **Post-connect UX:** `connectRemote` awaits `gitSetup` + controller
  restart, but the launch pull is fired non-blocking inside `start()` — so
  the drawer closes as soon as the remote is wired and the existing status
  pill/row shows `Syncing` while the first pull runs. No progress UI in the
  drawer.

## Phase 2 — copy

Small, in the copy-simple-sparse register:

- Graphs screen local-group footer (`apps/desktop/src/mobile/screens/graphs.tsx`):
  "Notes stay on this device." → "Notes stay on this device. Sync with
  GitHub from Settings." (drop the second sentence when a repo is connected —
  optional polish, not required).
- Onboarding "This device" card (`apps/desktop/src/mobile/onboarding-screen.tsx`):
  append one line to the existing description so the option no longer reads
  as a dead end: "You can sync with GitHub later from Settings."

## Phase 3 — tests + verification

- **Hook:** the dialog's existing tests already exercise the wizard paths
  through the desktop shell; add hook-level tests only for what the shells
  don't reach (poll stop conditions, single-shot finish).
- **Drawer:** screen tests with the drawer mock pattern from the tasks
  quick-edit sheet work (vaul portals don't render in jsdom): happy path
  create-new, happy path existing, public-confirm branch, and the
  local-only/disconnected-only visibility matrix for the settings row.
- **Dev harness:** smoke the settings screen and drawer under
  `?platform=ios` — new IPC on the boot/connect path must not rot the
  browser bridge (PR #538 lesson). Rendering only: without the shell,
  `providerFetch` falls back to plain `fetch`, and GitHub's device-flow
  endpoints reject browser CORS — the full flow is device/simulator-only.
- **Manual device pass (release gate for the feature):**
  1. iPhone, local graph, device flow end-to-end (copy code → Safari →
     authorize → return → connected).
  2. Connect the repo an existing desktop graph backs up to; verify the
     phone's seeded content merges (no fork, no duplicate notes) and edits
     round-trip phone ↔ desktop.
  3. Background the app mid-poll and resume (spike 2's scenario, on the real
     device).
  4. PAT fallback path once (paste from clipboard).

## Risks

- **Device-flow poll under iOS suspension** is the biggest remaining unknown
  (Phase 0 spike 2). If WKWebView kills rather than suspends the fetch loop,
  the remedy is a resume-time retry inside the auth step, not a new flow.
- **Clipboard API availability** (spike 1) — has a working-but-clunky
  fallback either way, so it can't block the feature, only polish.
- **First-sync merge on a non-empty phone graph:** the local graph seeds a
  daily note, and the repo likely has one for the same date. This is the same
  shape as desktop's connect-existing-to-existing-graph path and goes through
  the same merge ladder; the manual matrix (item 2) is the proof, not new
  code.
- **PAT entry stays as the escape hatch** (GHES, users who prefer scoped
  tokens) — `GithubAuthStep` already renders it; the only mobile question is
  whether the paste field behaves in the drawer, covered by manual pass
  item 4.

## Deferred

- Restore-shaped onboarding ("start from your GitHub backup" as a first-run
  option next to iCloud/This device).
- Surfacing `backUpNow` on mobile (a "Back up now" row) — trivial once the
  group is always visible, but not needed for the sync story.
- Android (no keychain/keyring story validated there yet).
