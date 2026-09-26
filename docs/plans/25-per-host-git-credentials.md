# Plan 25 — Per-Host Git Credentials (generic remotes on iOS)

**Goal:** back a graph up to a non-GitHub git host from
**iOS**, by storing one credential per host in the OS keychain and
authenticating over HTTPS. This closes Plan 16's deferred item *"per-host
token entry UI / per-host keychain entries (the moment we want 'no terminal
ever' for non-GitHub hosts)"* — and on a phone there is no terminal, ever.
**No new sync mechanism, no engine changes.**

**Depends on:** Plan 12 (the sync loop, merge ladder, conflict policy), Plan 16
V1 (remote classification and the adoption gate this plan widens), Plan 21
(iCloud and a Git remote are mutually exclusive per graph, which makes the
local graph the one allowed a remote), Plan 22 (the mobile connect-surface
idiom).

**Status:** proposed, with the implementation in the same PR. Verified
end-to-end in a fork build on the iOS simulator against a non-GitHub git host
(2026-09-21): credential stored in the device keychain, remote adopted,
commits pushed, `origin/main` advanced.

## Why desktop is not the point

Desktop has synced to non-GitHub hosts since Plan 16 V1 shipped: `git remote
add origin git@host:you/notes.git` and the agent authenticates it. Nothing here
is needed for that, and the SSH path is untouched.

iOS is the gap. There is no ssh-agent on a phone, so Plan 16's transport has no
story there, and Plan 22 recorded that honestly when it deferred SSH on mobile.
Plan 16 V2's answer for HTTPS — `Cred::credential_helper`, which executes the
user's helper program — **cannot run on iOS** either: the sandbox does not
permit executing arbitrary binaries, there is no `git` on `PATH`, and there is
no terminal in which to seed a helper with a one-time `git push`.

That leaves a username and token over HTTPS, held in the keychain. It is the
only transport a phone can actually use, and it happens to work on desktop too
for anyone who would rather type a token once than wire up SSH.

**Explicitly not in scope:** SSH on mobile (see Deferred); repo-creation or
visibility REST sugar for other hosts (Plan 16 keeps those GitHub-only);
OAuth/device-flow against non-GitHub hosts; writing credentials back to git
credential helpers; Android; encryption of repository contents (see Deferred,
and read that item before adopting this plan for privacy reasons).

## Contracts

1. **A credential never reaches a host it was not stored for.** Credentials are
   keyed by the remote's origin — scheme, host and port — and resolved against
   the *current* origin each cycle, and fetch, push and clone refuse off-site
   redirects (libgit2's default follows one on the first request and would then
   ask for the new host's credentials); the managed GitHub sign-in lives in its own
   store in `github.ts` and is only ever sent to github.com. This is Plan 16
   §1's invariant — the security wart that plan existed to close — and it is
   tested at both layers: core's routing (`git-credentials.test.ts`, the
   controller tests) and Rust's presentation (`credential_tests`).
2. **TypeScript owns policy, Rust owns the primitive.** `git/remote.rs` knows
   how to present an HTTPS basic-auth credential and nothing about GitHub.
   Core decides which credential belongs to a remote.
3. **Secrets live only in the OS keychain** — never in markdown, `.reflect/`,
   git config, or the remote URL.
4. **No new sync mechanism.** Adoption, the merge ladder, conflict policy,
   status surfaces and the mobile background flush are untouched.
5. **Host visibility stays the user's responsibility.** There is no host API to
   check whether a non-GitHub repo is private, so Plan 16 §5's documentation
   stands: **notes marked `private: true` are included in the backup.**

## Design

### 1. One credential shape (Rust, `git/remote.rs`)

`BasicCredential { username, secret }` replaces the bare `token: Option<String>`
threaded through `fetch`, `push` and `clone`. The managed GitHub sign-in
arrives as username `x-access-token`, which is exactly what the old code
hardcoded, so its behaviour is unchanged.

An earlier revision made this a tagged enum (`Github` vs `Host`) so the two
could never be interchanged. That was dropped: it put a policy decision in the
Rust type where core already makes it, and it made `remote.rs` know about
GitHub, contradicting its own "remote-agnostic" docstring. Contract 1 is
enforced where the decision is actually made — in core, with tests.

### 2. The single-shot guard, and why it is uniform

A supplied credential is offered **once**. The second ask becomes an
actionable `Auth` error rather than another attempt.

What libgit2 does without it, from the vendored source (`transports/http.h`,
`GIT_HTTP_REPLAY_MAX`) and measured against a loopback server (see
`credential_loop_tests`):

| Case | Callback invocations |
| --- | --- |
| Credential accepted, fetch or clone | 1 |
| Credential accepted, push (two HTTP requests) | 1 — the connection reuses it |
| Credential rejected | 15 challenges in total, then "too many redirects or authentication replays" |

So the guard costs nothing on the success path, including a push's second
request. What it buys is one attempt instead of fifteen, and a message that
says what to do. That matters on exactly this plan's path: for a non-GitHub
remote the Settings UI displays `status.message`, so the user reads it; for
GitHub the UI substitutes "reconnect GitHub", so there the guard is only a
saving of round-trips. It is applied uniformly because the credential shape is
uniform — `remote.rs` no longer knows which host it is talking to.

### 3. Per-host resolution (core TS)

`packages/core/src/sync/git-credentials.ts`:

- `remoteCredentialOrigin(remoteUrl)` — the URL's origin as the parser
  normalises it (lowercased, default port dropped), or `null` for a remote that
  takes no credential. The **scheme** is part of the identity so an `https`
  credential is never sent to the `http` form of the same host in cleartext;
  the **port** is, so a host on `:8443` is a different credential from the
  same name on `:443`.
- `gitCredentialSecretName(origin)` — `git-credential:<origin>`.
- `loadGitCredential` / `saveGitCredential` / `deleteGitCredential`, storing
  Zod-validated JSON. A corrupt entry reads as absent, so the user re-enters it
  rather than being wedged, and is logged so it can be told apart from a
  credential never stored.
- `githubCredential(token)` — the managed sign-in as `x-access-token`.

The engine's `getCredential` resolves **per cycle, against the current
origin** — not the URL captured at adoption. A connect made in the app stops
the engine before moving `origin` and restarts it afterwards, because a cycle
reuses its credential for every command it issues; the per-cycle read covers
a remote re-pointed outside the app (`git remote set-url`) between cycles. A
re-entered token takes effect without restarting the app.

### 4. Adoption gate (controller)

Plan 16 V1 rejects any generic `http(s)://` remote at adoption. That becomes
conditional: reject only when **no credential is stored for that host**. The V1
reasoning survives — an uncredentialed HTTPS remote would pull anonymously and
only 401 on push, silently stranding local edits — while a credentialed one is
adopted and any auth failure surfaces through the existing status states.

Disconnect drops the remote but **keeps** the host credential. It is keyed by
origin, not by graph, so deleting it would silently break every other graph
backed up to the same host — the same reason the machine-level GitHub sign-in
survives a disconnect. `connectHostRemote` refuses github.com URLs, which
belong to the managed sign-in; a token stored for one would never be read.

### 5. The connect surface (mobile)

`mobile/connect-host-drawer.tsx`: remote URL, username, access token, in the
`ConnectGithubDrawer` idiom, behind the same local-graph-only gate. The URL is
validated through the same `remoteCredentialOrigin` parser the keychain uses,
so a URL that would key the credential differently cannot be accepted. The
token field is a password field, and the helper text names the origin it will
be sent to.

`connectHostRemote` on the backup controller saves the credential, points
`origin` at the URL through the existing `gitSetup`, and restarts.

## What the verification established

Run on the iOS simulator against a non-GitHub git host:

- `keyring` with `apple-native` round-trips on iOS — the open item from Plan 22
  Phase 0 spike 3.
- libgit2 authenticates to a non-GitHub host with username + token from the
  iOS build; commit and push succeed and `origin/main` advances.

## Failure cases

| Case | Behavior |
| --- | --- |
| HTTPS remote, no credential stored | Rejected at adoption, as in Plan 16 V1. |
| Wrong username or token | One attempt, then an `Auth` error the user can act on; retried on focus (§2). |
| Credential deleted externally | Next cycle reports `Auth`; the sheet re-enters it. |
| Self-signed TLS | libgit2's default verification applies and fails. **Not bypassed** — the same posture as Plan 16's known_hosts stance. |
| GitHub token near another host | Never sent (contract 1), with unit tests. |
| Host redirects to another host | Refused — `cannot redirect` — before any credential is offered. Same-host redirects, including an upgrade to https, still work. |
| Host redirects to another port on the same host | Followed: libgit2's off-site check compares host names only, so the credential stored for one port can reach another. Needs a shared host where ports belong to different people; not closed here. |
| Connect while a cycle is running | The engine stops before `origin` moves, so the running cycle issues nothing further; a failed setup restarts the old engine. |
| Host rejects a push | Already data: `PushOutcome.rejection_message` surfaces verbatim. |

## Deferred

- **Branch alignment.** `connectHostRemote` passes no branch, because there is
  no host API to ask for a repo's default. Against an empty repo that is fine;
  against a repo whose default branch is named differently, sync would push a
  parallel branch rather than merge. A branch field, or a post-fetch check,
  closes this.
- **Desktop connect surface.** The credential path works on desktop, but
  nothing there writes a credential yet, and desktop users have SSH. A field in
  `backup-section.tsx` would be a small addition.
- **SSH on mobile** via `Cred::ssh_key_from_memory` with the key in the
  keychain. Strictly larger — key import, passphrase handling, and known_hosts
  management with no terminal — for the same outcome.
- **Plan 16 V2 credential helpers on desktop.** Orthogonal; §3's routing
  accommodates both.
- **Encrypted repository contents.** Worth recording because it is the usual
  motive for leaving GitHub: a git-crypt/transcrypt-style setup **will not work
  through Reflect**. Those tools run clean/smudge filter drivers declared in
  `.gitattributes`, and libgit2 executes only its built-in filters unless
  custom ones are registered through the C filter API — Reflect registers none,
  and staging is a bare `index.add_all`. So `git` in a terminal would encrypt
  while Reflect's background sync commits **plaintext** to the same repo: a
  silent confidentiality failure, worse than no encryption. This plan delivers
  control over *which host* holds the data, not privacy from that host.
