# Plan 25 - Sync Model (GitHub, Git, iCloud)

**Goal:** One clear model for how a graph syncs. Three independent objects,
a typed classification of the `origin` remote, one rule for where each
sign-in may go, and one vocabulary for the UI.

**Depends on:** Plan 12 (sync loop), Plan 16 (generic git remotes), Plan 21
(iCloud Drive sync), Plan 10 (keychain). **Status: implemented** (#1687,
#1688, #1690, #1691, #1689, #1707, #1702).

## The three objects

| Object | Level | What it is |
| --- | --- | --- |
| GitHub account | Machine | One sign-in: a GitHub App token from the device flow (with a refresh token) or a personal access token. It serves GitHub repositories and gist publishing. It does not depend on any graph. |
| Git repository | Graph | `origin` plus where its sign-in comes from. |
| iCloud hosting | Graph | A fact of the graph path. The user cannot configure it. |

The three objects do not depend on each other. A graph can use a GitHub
repository without an iCloud path. An iCloud graph can have no repository.
The GitHub account can exist with no graph connected.

## `GitRemote` classification

`classifyRemote` in `packages/core/src/sync/remote-url.ts` maps `origin` to
one of four kinds:

- `github`: `https://github.com/owner/repo`. The GitHub account serves it.
- `https`: any other `http(s)://` host. A per-host sign-in serves an
  `https://` host. A plain `http://` host lands here too, but gets no
  sign-in: Reflect never sends one in the clear, so such a remote stays in
  `needsCredential` until its address is `https://`.
- `ssh`: `git@host:…` or `ssh://`, github.com included. The ssh-agent serves
  it; Reflect stores nothing.
- `path`: a local or mounted path. It needs no credential.

## The sync state

`GitSyncService` has the phases `loading`, `disconnected`, `needsCredential`,
and `connected`. `needsCredential` means `origin` is set, but no sign-in is
stored for it. The `connected` phase carries `isPrimaryChannel`: true when
the repository carries the notes between devices, false on an iCloud-hosted
graph, where iCloud carries them and the repository keeps a history that
updates after five quiet minutes.

The old model had two bad states for a missing sign-in. `disconnected` hid a
remote that was in fact set. `connected` with a rejected error looked healthy
but could never push. Now the UI shows "Sign-in needed" with "Add sign-in…",
and the sync loop does not run (desktop keeps the local history commits).

## Credential invariants

1. A sign-in only reaches the origin it was stored for. The GitHub account
   only reaches github.com. A host entry only reaches its own origin. SSH and
   path remotes get no sign-in (`credential-resolver.ts`).
2. GitHub keeps its own keychain entry, because it has a refresh token. A
   host sign-in has no refresh token.
3. A host sign-in is keyed by scheme, host, and port. The keychain entry is
   `git-credential:<origin>`. One sign-in serves every graph on that origin.
4. The connect flow probes the host before it stores anything
   (`git-host-connector.ts`). A bad address, username, or token stores
   nothing. Updating a sign-in probes the configured `origin` and never
   changes the remote or the branch.
5. "Stop syncing" drops `origin` and keeps the sign-in. Other graphs may use
   it.
6. The Rust guard in `crates/git/src/remote.rs` never presents a stored
   sign-in to a host other than the one it was stored for. It refuses after a
   cross-host redirect. The SSH path uses the ssh-agent only.
7. A sign-out that lands while a GitHub probe or token refresh is in flight
   has the last word: the probe does not mark the machine connected again,
   and the refresh does not store the new pair.

## Naming rule

- The UI names destinations with nouns: "iCloud Drive", "Git repository",
  and, under Accounts, "GitHub".
- The Git surfaces always speak of sync: "Up to date", "Syncs in 2 minutes",
  "Sync now", "Stop syncing", "Sync failed: …". On an iCloud-hosted graph the
  card description says the repository keeps the history, and the manual
  action is "Save history now", because the engine only commits there; the
  repository updates after the quiet window.
- The UI names no git host other than GitHub. The chooser's second option
  is "Other host"; a connected remote is still shown by its own host and
  path, such as `gitlab.com/alex/notes`.
- The word `backup` stays only for history and restore.

## UI shape

Settings → Sync holds two rows: "iCloud Drive" and "Git repository". The Git
row has one door, "Connect a repository…", which asks where the repository
is: GitHub, or Other host. GitHub gets the connect wizard; Other host gets a
form with the repository address, a username, and an access token or
password. Settings → Accounts holds the machine's GitHub sign-in, which
belongs to no graph. iOS has the same groups: "Git repository" (Connect a
repository, Add or Update sign-in, Stop syncing) and "Accounts".

## Code map

- `packages/core/src/sync/remote-url.ts`: `classifyRemote`, `redactRemoteUrl`.
- `packages/core/src/sync/credential-resolver.ts`: picks the sign-in for a
  remote.
- `packages/core/src/sync/git-host-credential-service.ts`: per-origin host
  sign-ins in the keychain.
- `packages/core/src/sync/git-sync-service.ts`: state phases and
  `isPrimaryChannel`.
- `packages/core/src/sync/github-connector.ts`: the GitHub connect flow.
- `packages/core/src/sync/git-host-connector.ts`: `connectGitHost` and
  `updateGitHostSignIn`.
- `packages/core/src/sync/github-forbidden.ts`: tells a 403 for a bad token
  from one for a refused repository.
- `packages/app/src/sync/remote-label.ts`: how surfaces name a remote.
- `apps/desktop/src/components/settings/connect-repository-dialog.tsx`: the
  door. `connect-git-host-form.tsx`: the Other host form.
- `crates/git/src/remote.rs`: the host guard and the SSH agent path.

User contract: [docs/generic-git-remotes.md](../generic-git-remotes.md).

## Deferred

- GitLab device flow, and REST sugar per host (repository creation,
  visibility checks).
- SSH key file selection.
- A "forget host sign-in" button.
- iCloud plus a Git repository on iOS (Plan 21 keeps them exclusive there).
