# Plan 25 - Sync Model (GitHub, Git, iCloud)

**Goal:** One clear model for how a graph syncs. Three independent objects,
a typed classification of the `origin` remote, one rule for where each
sign-in may go, and one naming rule for the UI.

**Depends on:** Plan 12 (sync loop), Plan 16 (generic git remotes), Plan 21
(iCloud Drive sync), Plan 10 (keychain). **Status: implemented.**

## The three objects

| Object | Level | What it is |
| --- | --- | --- |
| GitHub account | Machine | A sign-in with a refresh token. It serves GitHub repositories and gist publishing. It does not depend on any graph. |
| Git repository | Graph | `origin` plus where its sign-in comes from. |
| iCloud hosting | Graph | A fact of the graph path. The user cannot configure it. |

The three objects do not depend on each other. A graph can use a GitHub
repository without an iCloud path. An iCloud graph can have no repository.
The GitHub account can exist with no graph connected.

## `GitRemote` classification

`classifyRemote` in `packages/core/src/sync/remote-url.ts` maps `origin` to
one of four kinds:

- `github`: `https://github.com/owner/repo`. The GitHub account serves it.
- `https`: any other `http(s)://` host. A per-host sign-in serves it.
- `ssh`: `git@host:…` or `ssh://`, github.com included. The ssh-agent serves
  it; Reflect stores nothing.
- `path`: a local or mounted path. It needs no credential.

## The `needsCredential` state

`GitSyncService` has the phases `loading`, `disconnected`, `needsCredential`,
and `connected`. `needsCredential` means `origin` is set, but no sign-in is
stored for it. The `connected` phase also carries a `coexisting` flag for
iCloud-hosted graphs.

The old model had two bad states for this case. `disconnected` hid a remote
that was in fact set. `connected` with a rejected error looked healthy but
could never push. Now the UI shows "Sign-in needed" and an "Add sign-in…"
button, and the sync loop does not run (desktop keeps the local history
commits).

## Credential invariants

1. A sign-in only reaches the origin it was stored for. The GitHub account
   only reaches github.com. A host entry only reaches its own origin. SSH and
   path remotes get no sign-in (`credential-resolver.ts`).
2. GitHub keeps its own keychain entry, because it has a refresh token. A
   host sign-in has no refresh token.
3. A host sign-in is keyed by scheme, host, and port. The keychain entry is
   `git-credential:<origin>`. One sign-in serves every graph on that origin.
4. The connect flow probes the host before it stores anything
   (`host-connector.ts`). A bad URL, username, or token stores nothing.
5. "Stop syncing" drops `origin` and keeps the sign-in. Other graphs may use
   it.
6. The Rust guard in `crates/git/src/remote.rs` never presents a stored
   sign-in to a host other than the one it was stored for. It refuses after a
   cross-host redirect. The SSH path uses the ssh-agent only.

## Naming rule

- The UI names destinations with nouns: "iCloud Drive", "Git repository",
  "GitHub account".
- In single-channel mode, the Git card speaks of sync: "Up to date", "Sync
  now", "Stop syncing".
- On an iCloud-hosted graph (`coexisting`), the Git card speaks of backup:
  "Backed up", "Back up now", "Stop backing up". iCloud syncs. Git keeps a
  history that updates five minutes after edits go quiet.
- The word `backup` stays only for history and restore.

## UI shape

Settings → Sync shows two cards: "iCloud Drive" and "Git repository". The Git
card offers "Connect GitHub…" and "Another host…". The dialog asks for a
Repository URL, a Username, and an Access token. Below the cards, a "GitHub
account" row (sign in, sign out) works without a graph. iOS has the same
rows: a "Git repository" group (Connect GitHub, Connect another host, Stop
syncing) and a "GitHub account" group.

## Code map

- `packages/core/src/sync/remote-url.ts`: `classifyRemote`.
- `packages/core/src/sync/credential-resolver.ts`: picks the sign-in for a
  remote.
- `packages/core/src/sync/git-host-credential-service.ts`: per-origin host
  sign-ins in the keychain.
- `packages/core/src/sync/git-sync-service.ts`: state phases and the
  `coexisting` flag.
- `packages/core/src/sync/github-connector.ts`: the GitHub connect flow.
- `packages/core/src/sync/host-connector.ts`: the "Another host" flow.
- `crates/git/src/remote.rs`: the host guard and the SSH agent path.

User contract: [docs/generic-git-remotes.md](../generic-git-remotes.md).

## Deferred

- GitLab device flow, and REST sugar per host (repository creation,
  visibility checks).
- SSH key file selection.
- A "forget host sign-in" button.
