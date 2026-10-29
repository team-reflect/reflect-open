# Plan 22 — Mobile GitHub Connect (iOS)

**Goal:** the "This device" (local) graph on iOS can connect to a GitHub backup repo,
giving phone ↔ desktop sync without iCloud. The sync machinery already runs on mobile
(backup controller, background flush, Settings status + Disconnect). Only the front door
is missing: sign in and pick/create a repo from the phone. **No new sync mechanism, no
engine changes.**

**Depends on:** Plan 12 (backup controller, merge), Plan 19/PR #483 (`SyncProvider` in the
mobile tree, mobile quit-flush), Plan 21 contract 5 (iCloud and a Git remote are mutually
exclusive per graph, so the local graph is the one allowed a remote).
**Status:** implemented (Phases 0–3): wizard hook extraction (dialog tests pass
untouched), `ConnectGithubDrawer`, the Settings entry point, copy, and jsdom +
`?platform=ios` coverage. Remaining: the Phase 0 device spikes and the manual device
pass; both need a phone/simulator build.

**Not in scope:** GitHub for iCloud graphs; non-Git sync for local graphs; a
restore-from-repo onboarding (the phone joins an existing repo through the same flow);
Android; SSH remotes on mobile (Plan 16's agent auth has no phone story).

## Where we stand

**Reused unchanged:**

- **Engine + lifecycle.** `SyncProvider` is mounted in `mobile-app.tsx`, and
  `connectNewRepo` / `connectExistingRepo` / `disconnectGraph` / `signOut` are already
  exposed through `useSync()`.
- **Rust.** The git2 module already builds for iOS (PR #483). Credentials use `keyring`
  with `apple-native`, which covers the iOS keychain.
- **Core auth** (`runDeviceFlow`, auth save/load, repo create/get) is platform-neutral.
  `GITHUB_APP_CLIENT_ID` is a hardcoded constant, so iOS builds need no injection.
- **Transport (verified).** GitHub calls go through `providerFetch` →
  `tauri-plugin-http`, so they leave from Rust and webview CORS never applies. This
  matters: the device-flow token endpoints send no CORS headers. The plugin registers on
  all platforms (`src-tauri/src/lib.rs:105`) and `capabilities/default.json` has no
  `platforms` filter, so the http scope and opener grant already apply on iOS.
- **Desktop UI.** `GithubAuthStep` is already the shared sign-in step (device flow, PAT
  fallback, verified via `GET /user`). `ConnectGithubDialog` holds the full wizard
  (repo → auth → finish, create-handoff poll, grant-access step, public-repo consent).
- **Mobile substrate.** Inset-grouped settings primitives, the vaul Drawer idiom
  (`new-graph-drawer.tsx`), and the Backup group in `mobile/screens/settings.tsx`, which
  renders only when connected.

**The gap:** no mobile surface calls `GithubAuthStep` or the connect methods. The Backup
group is invisible for a disconnected local graph, and the `settings.tsx` docstring still
says "connecting happens in onboarding" (a leftover from removed onboarding).

## Contracts

1. **Local graphs only.** The entry point renders only when `mobileStorageKind ===
   'local'` and the backup phase is `disconnected`. Gate on storage kind, not a root-path
   sniff.
2. **One wizard, two shells.** The state machine moves from `ConnectGithubDialog` into a
   hook; desktop Dialog and mobile Drawer are thin renderings. No forked flow logic.
3. **Same safety gates as desktop:** destructive-styled public-repo consent;
   grant-access steers to "Only select repositories"; a failed connect can go back to the
   repo step.
4. **The phone joins, it does not fork.** Connect-existing aligns the local branch with
   the repo's default branch, and the launch pull merges via Plan 12. The near-empty phone
   graph merges into desktop history, never the reverse.

## Phase 0 — extraction + spikes

- **Extract `hooks/use-connect-github-wizard.ts`** (steps, create-vs-existing, target-ref
  from the verified user, `finish()` branches, existence/access poll).
  `ConnectGithubDialog` becomes a shell with **zero behavior change**: its existing tests
  passing untouched is the acceptance test. `GithubAuthStep` has one consumer (its
  "restore dialog" docstring is aspirational). `useRestoreFocus` stays in the desktop shell.
- **Device-flow spikes in WKWebView** (simulator + device, before UI work):
  1. `navigator.clipboard.writeText` in a tap handler. Tauri iOS uses a custom scheme, so
     the async clipboard may be absent. The manual-copy fallback exists; if needed, pick
     the smaller of touch-friendlier copy or `tauri-plugin-clipboard-manager`.
  2. `openUrl` → Safari → return: the `runDeviceFlow` poll must resume on foreground
     (codes live ~15 min; `slow_down` is handled). Verify, do not assume.
  3. `keyring` round-trip on iOS; `apple-native` should cover it but has never run there.

  Whether GitHub requests can leave the app at all was settled in planning (see
  *Transport*).

## Phase 1 — the mobile connect surface

- **`mobile/connect-github-drawer.tsx`**, a vaul Drawer driving the hook:
  - *Repo step:* create-new (name) vs use-existing (`owner/name`). **Do not pass the graph
    name to `suggestRepoName`:** the local graph's name is the sandbox folder basename,
    "Documents", which would suggest `documents-backup`. Mobile takes the `reflect-backup`
    fallback.
  - *Auth step:* `GithubAuthStep` as-is; tweak styling only if something breaks.
  - *Finish step:* spinner plus the hook's three parked states (public-confirm,
    create-guide + poll, grant-access + poll).
- **Settings entry point:** show the Backup group for disconnected local graphs with a
  "Connect GitHub" row. Today `mobileSyncStatus` returns `null` for every non-`connected`
  phase. During `loading`, show the row disabled (or nothing) so it never flashes on a
  graph that turns out connected. Connected and iCloud behavior stay as today. Fix the
  stale docstring.
- **Gating:** `mobileStorageKind` from `useGraph()`, no new plumbing.
- **Post-connect UX:** `connectRemote` awaits git setup + controller restart, but the
  launch pull is non-blocking, so the drawer closes once the remote is wired and the
  status row shows `Syncing`. No progress UI in the drawer.

## Phase 2 — copy

- Graphs screen local footer: "Notes stay on this device." → "Notes stay on this device.
  Sync with GitHub from Settings." (dropping the second sentence when connected is
  optional).
- Onboarding "This device" card: add "You can sync with GitHub later from Settings." so
  it is not a dead end.

## Phase 3 — tests + verification

- **Hook:** the dialog tests already cover the wizard; add hook tests only for what the
  shells miss (poll stop conditions, single-shot finish).
- **Drawer:** screen tests with the drawer mock pattern (vaul portals do not render in
  jsdom): create-new, existing, public-confirm, and the settings-row visibility matrix.
- **Dev harness:** smoke under `?platform=ios` so new IPC does not rot the browser bridge
  (PR #538 lesson). Rendering only: without the shell, `providerFetch` falls back to plain
  `fetch` and GitHub rejects browser CORS, so the full flow is device-only.
- **Manual device pass (release gate):**
  1. Device flow end-to-end (copy → Safari → authorize → return → connected).
  2. Connect a repo a desktop graph backs up to; seeded content merges without fork or
     duplicates; edits round-trip.
  3. Background mid-poll and resume.
  4. PAT fallback once (paste from clipboard).

## Risks

- **Poll under iOS suspension** is the biggest unknown. If WKWebView kills the loop, the
  fix is a resume-time retry in the auth step, not a new flow.
- **Clipboard availability** has a clunky fallback either way, so it only affects polish.
- **First-sync merge:** the phone seeds a daily that likely collides with the repo's for
  the same date. Same shape as desktop connect-existing, same merge ladder; manual item 2
  is the proof.
- **PAT stays the escape hatch** (GHES, scoped tokens); manual item 4 checks the paste
  field in the drawer.

## Deferred

- Restore-shaped onboarding ("start from your GitHub backup").
- A mobile "Back up now" row.
- Android (no keyring story validated).
