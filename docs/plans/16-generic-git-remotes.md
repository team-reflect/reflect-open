# Plan 16 — Generic Git Remotes (Bring Your Own Host)

**Goal:** Back up and sync a graph to **any git remote** — GitLab, Gitea, Codeberg,
GitHub Enterprise, a self-hosted server, or a bare repo on a NAS — with **zero new UI**.
The contract: a user runs `git init` (or Reflect already did) and
`git remote add origin <url>` in their graph, and the existing sync loop (Plan 12)
adopts it — debounced commit → push, pull/merge on launch/focus, conflicts-as-data.
Everything else just works.

**Delivery is two waves.** **V1 is SSH-only** (agent auth), which also gets path
remotes for free: the credential code is a few deterministic lines, `git@…` is the
URL form muscle memory pastes, and the user contract is one sentence — *if
`ssh -T git@host` works, sync works*. **V2 adds HTTPS** via git credential helpers;
executing a helper program from a GUI app is the riskiest unknown in the whole plan
and deserves its own wave (and spike) rather than holding V1 hostage.

**Depends on:** Plan 12 (the whole sync loop; this plan only widens its credential
story). **Status:** V1 implemented (SSH agent + path remotes; see
[docs/generic-git-remotes.md](../generic-git-remotes.md) for the user contract).
Outstanding V1 validation, manual by nature: agent auth from the *packaged* app
against a real host (the Phase 0 spike items). V2 (HTTPS credential helpers) not
started.

**Explicitly not in scope:** host pickers, a "custom remote" wizard, per-host settings
UI, or per-host REST sugar (repo creation, visibility checks, install links — those
stay GitHub-only conveniences). File-sync providers were unsupported by design when
this was written — [Plan 21](./21-icloud-drive-sync.md) has since shipped iCloud Drive
as the primary sync path (Dropbox et al. remain unsupported); either way, this plan is
about other *git hosts*, not other *sync mechanisms*.

## Where we stand (why it doesn't work today)

The Plan 12 architecture already did most of the work: the Rust layer speaks
`remote URL + credential callback`, token plumbing is nullable end-to-end
(`gitFetch(token: string | null)` → `Option<String>`), and the engine, controller,
and conflict policy are host-agnostic. Four things block a hand-wired remote:

1. **Adoption gating.** `backup-controller.start()` refuses to adopt unless a
   **GitHub** credential is stored (`loadGithubAuth() !== null`), even though the
   repo + remote are fine.
2. **Credential routing — also today's one security wart.** The engine feeds
   `getGithubToken()` into every fetch/push, and `remote.rs` sends it as
   `x-access-token:<token>` basic auth to **whatever host origin points at**. A
   hand-wired non-GitHub origin would today (a) fail auth and (b) leak the user's
   GitHub token to that host. Fixing the routing is worth landing even if the rest
   of this plan stalls.
3. **HTTPS-only build.** `git2` is compiled `default-features = false,
   features = ["https", "vendored-libgit2"]` — `git@host:…` remotes cannot connect
   at all, and SSH is the URL form most users will paste.
4. **Credential callback is token-or-fail.** `callbacks_with_credentials(None)`
   errors with "no token is connected" instead of trying anything local.

## Design

### 1. Remote-aware credential routing (core TS) — V1, shared by every wave

Classify the remote once at adoption: `parseGithubRemote(remoteUrl)` non-null →
**github**, else **generic**.

- **github** → unchanged: `getToken: () => getGithubToken(providerFetch)` (device-flow
  refresh and all).
- **generic** → `getToken: () => null`, always. The Rust side resolves credentials
  locally (below). The stored GitHub credential is **never** offered to a non-GitHub
  host — closing wart (2) regardless of which transports ship when.

GitHub Enterprise falls out naturally: `ghe.corp.com` doesn't parse as github.com, so
it takes the generic path — SSH in V1, credential helpers in V2.

### 2. Local credential resolution (Rust, `remote.rs`)

When the per-call token is `None`, the credential callback becomes a chain driven by
libgit2's `allowed` types instead of an error. When the token is `Some(…)` (GitHub
path), behavior is byte-for-byte today's.

**V1:**

- `SSH_KEY` → `Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"))`.
  **Agent-only** — no key-file scanning, no passphrase prompting; the agent *is* the
  contract (macOS runs one by default; passphrase keys work because the agent holds
  them unlocked). **Retry guard:** libgit2 re-invokes the callback after a rejected
  credential, which loops forever if we keep producing the same answer — second ask
  fails with an `Auth` error naming the fix ("the SSH agent had no accepted key for
  this host — `ssh-add` your key, or check `ssh -T git@<host>` works").
- `USER_PASS_PLAINTEXT` (generic HTTPS remote) → **fail fast and honest**: "HTTPS
  authentication for non-GitHub hosts isn't supported yet — use an SSH remote URL
  (`git@host:owner/repo.git`)". No half-trying.
- Path remotes never invoke the callback at all — **bare repos on a NAS/USB/second
  disk work in V1 with no credentials**, and become the medium for cheap full-loop
  integration tests (commit → push → clone → conflict → merge; zero network, zero
  mocks).

**V2:**

- `USER_PASS_PLAINTEXT` → `Cred::credential_helper(&repo.config()?, url,
  username_from_url)`. git2-rs implements helper execution itself: it reads
  `credential.helper` from git config and runs the helper (`osxkeychain` on macOS,
  `manager` on Windows, `libsecret`/`store` on Linux). The user's one-time
  `git push` from a terminal stores a login in the same place we read from. We
  *read* helpers, never write them.
- `DEFAULT` → `Cred::default()` (NTLM/Negotiate proxies; cheap to include).

### 3. SSH transport (V1)

`git2 = { features = ["https", "ssh", "vendored-libgit2"] }` — adds vendored
`libssh2`. Host-key verification: libgit2 ≥ 1.5 enforces known_hosts checking by
default (post-CVE-2023-22742); we keep the default and **do not** install a
permissive `certificate_check`. An unknown host fails with a hint:
"connect once with `ssh <host>` so it's added to known_hosts".

### 4. Adoption gating (backup controller) — V1

`start()` adopts when `status.initialized && remoteUrl !== null` — and then:

- **github remote** → still requires `loadGithubAuth() !== null` (otherwise
  `disconnected`, as today: the wizard is the fix).
- **generic remote** → adopt unconditionally. If local credentials turn out missing,
  the first cycle surfaces the auth error in the existing status UI and the engine
  keeps retrying on focus — same shape as any other sync error, no new states.

### 5. Existing-surface degradation audit (not new UI) — V1

The generic path bypasses the wizard entirely, but a few connected-state surfaces
assume GitHub when `repo === null`:

- Settings/status panel: show the bare remote URL (already carried in state); hide
  "View on GitHub"-style affordances and the app-install link.
- `auth`-state recovery action: for github remotes it reopens the wizard; for generic
  remotes the message points at the terminal instead of a sign-in that can't help.
- Public-repo confirmation: API-based, GitHub-only. Generic remotes skip it — wiring
  your own remote is the opt-in. Documented loudly (notes marked `private: true` are
  in the backup; host visibility is the user's responsibility).
- `MAX_FILE_BYTES` (95 MB) guard stays for all remotes (every sensible host has a
  limit; ours just mirrors GitHub's). Message drops the "for GitHub" phrasing.

### 6. Restore on a new machine — V1 (docs only)

`git clone <url>` in a terminal, then open the folder as a graph. Adoption (§4) picks
the remote up and the index rebuilds from files (Plan 04). This already nearly works;
it becomes the documented generic-restore path. Restore-from-GitHub dialog stays
GitHub-only.

## V1 phases (SSH + path remotes)

**Phase 0 — Spike (small).** (a) Agent auth from the *packaged* app: a
launchd-launched GUI app must see `SSH_AUTH_SOCK` (macOS's default agent uses a
launchd socket, so it should; third-party agents like 1Password need one manual
check). (b) Vendored libssh2 through the macOS sign/notarize pipeline and the
Windows/Linux builds; record the binary-size delta.

**Phase 1 — Rust.** `ssh` feature; credential callback chain (agent + retry guard +
HTTPS fail-fast); error-taxonomy pass in `error.rs` (today anchors on
`ErrorCode::Auth` + HTTP status substrings; add the SSH/certificate classes so
agent-miss, rejected key, and host-key failures land in `Auth`/`Network` correctly,
with negative tests). Full-loop integration tests over local bare-path remotes with
`token: None`.

**Phase 2 — Core TS + controller.** Remote classification, `getToken` routing
(github → token, generic → null), adoption gating, status-message wording, the §5
audit. Unit tests: classification, controller adopts a generic remote with no stored
GitHub auth, github-auth never requested for generic remotes.

**Phase 3 — Docs + validation.** README/docs "Use any git host (SSH)" section with
the terminal recipe (init, `git remote add origin git@…`, confirm `ssh -T`); Plan
12's Deferred line moves to a pointer here; libraries.md gains libssh2. Manual
matrix: GitLab.com over SSH, Gitea in Docker over SSH, bare path remote on an
external volume, GHES over SSH if reachable.

## V2 phases (HTTPS via credential helpers)

**Phase 0 — Spike.** `Cred::credential_helper` from inside the GUI app on macOS:
helpers resolve via `git` on a GUI-app `PATH` (`/usr/bin` has Apple git, but CLT
presence and helper discovery need proving — same class of gotcha as the CLI
sidecar). Git Credential Manager prompting behavior on Windows (helpers may pop
their own UI).

**Phase 1 — Rust.** Helper + `Cred::default()` join the chain; the V1 HTTPS
fail-fast message is replaced by real resolution; helper-miss keeps a terminal-hint
error ("run `git push` from a terminal in this graph once so the credential helper
stores a login").

**Phase 2 — Docs + validation.** HTTPS recipe (the one-time `git push -u` to seed
the helper). Matrix: GitLab.com over HTTPS + osxkeychain, GHES over HTTPS, Windows
GCM.

## Failure cases

| Case | Behavior |
| --- | --- |
| No agent / key not added (V1) | `Auth` error in status: "`ssh-add` your key, or check `ssh -T git@<host>` works". Engine retries on focus; nothing wedges. |
| Generic HTTPS remote (V1) | Immediate, clear status error suggesting an SSH remote URL — not a hang, not a half-try. |
| Unknown SSH host key | Fail (no bypass): "connect once with `ssh <host>`…". |
| Helper exists but prompts (GCM UI, V2) | Helper runs outside our process; worst case it pops its own dialog or fails → `Auth` error with the terminal hint. Spike confirms osxkeychain never prompts. |
| Host rejects a push (protected branch, size limits, hooks) | Already data: `PushOutcome.rejection_message` surfaces verbatim, non-FF retries merge-then-push as today. |
| Remote deleted / URL typo | Existing not-found/network mapping; status error, retry on focus. |
| GitHub token near a generic remote | Never sent (§1). The reverse — local credentials for github.com — also never happens; github remotes always use the managed token. |

## Deferred (beyond V2)

- Per-host token entry UI / per-host keychain entries (the moment we want "no
  terminal ever" for non-GitHub hosts).
- Default key-file fallback (`~/.ssh/id_ed25519`, `id_rsa`) if agent-only proves too
  strict in practice; SSH passphrase prompting (agent covers passphrase keys).
- Writing credentials back to helpers.
- GitLab/Gitea REST sugar (repo creation, visibility checks) behind the same
  one-module-per-host pattern as `github.ts`.
- `git://` and proxy edge cases beyond what libgit2 defaults handle.
