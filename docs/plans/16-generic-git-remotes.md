# Plan 16 — Generic Git Remotes (Bring Your Own Host)

**Goal:** Back up and sync a graph to **any git remote** (GitLab, Gitea, Codeberg,
GitHub Enterprise, a self-hosted server, a bare repo on a NAS) with **zero new UI**. The
contract: the user runs `git init` (or Reflect did) and `git remote add origin <url>`,
and the Plan 12 sync loop adopts it (debounced commit → push, pull/merge on
launch/focus, conflicts-as-data).

**Two waves.** **V1 is SSH-only** (agent auth), which also gets path remotes for free:
the credential code is a few deterministic lines, `git@…` is the URL form users paste,
and the contract is one sentence: *if `ssh -T git@host` works, sync works*. **V2 adds
HTTPS** via git credential helpers. Running a helper program from a GUI app is the
riskiest unknown here, so it gets its own wave and spike instead of holding V1 hostage.

**Depends on:** Plan 12 (this plan only widens its credential story). **Status:** V1
implemented (user contract: [docs/generic-git-remotes.md](../generic-git-remotes.md)).
Outstanding V1 validation (manual): agent auth from the *packaged* app against a real
host. V2 not started.

**Not in scope:** host pickers, a "custom remote" wizard, per-host settings UI, or
per-host REST sugar (repo creation, visibility checks, install links stay GitHub-only).
This plan is about other *git hosts*, not other *sync mechanisms*;
[Plan 21](./21-icloud-drive-sync.md) later shipped iCloud Drive (Dropbox et al. remain
unsupported).

## Where we stood (why it did not work)

Plan 12 already did most of the work: the Rust layer speaks `remote URL + credential
callback`, the token is nullable end-to-end, and the engine, controller, and conflict
policy are host-agnostic. Four things blocked a hand-wired remote:

1. **Adoption gating:** the backup controller refused to adopt without a stored
   **GitHub** credential, even when repo + remote were fine.
2. **Credential routing, a security wart:** the GitHub token went into every
   fetch/push as basic auth to **whatever host origin points at**. A non-GitHub origin
   would fail auth and leak the GitHub token to that host. Worth fixing even if the rest
   stalled.
3. **HTTPS-only `git2` build:** `git@host:…` remotes could not connect at all.
4. **Token-or-fail callback:** with no token it errored instead of trying anything local.

## Design

### 1. Remote-aware credential routing (core TS), shared by every wave

Classify the remote once at adoption: parses as github.com → **github**, else
**generic**. github keeps the managed token (device-flow refresh and all). generic
always passes no token; Rust resolves credentials locally. The GitHub credential is
**never** offered to a non-GitHub host, which closes wart (2) regardless of transport.
GitHub Enterprise falls out naturally: it does not parse as github.com, so it takes the
generic path.

### 2. Local credential resolution (Rust)

With no token, the credential callback becomes a chain driven by libgit2's `allowed`
types. With a token (GitHub), behavior is unchanged.

**V1:**

- `SSH_KEY` → agent credential, username from the URL or `git`. **Agent-only:** no
  key-file scanning, no passphrase prompts. The agent *is* the contract (macOS runs one
  by default; it holds passphrase keys unlocked). **Retry guard:** libgit2 re-invokes
  the callback after a rejected credential and would loop forever on the same answer,
  so the second ask fails with an `Auth` error naming the fix (`ssh-add` your key, or
  check `ssh -T git@<host>`).
- `USER_PASS_PLAINTEXT` (generic HTTPS) → **fail fast and honest**: not supported yet,
  use an SSH URL. No half-trying.
- Path remotes never invoke the callback, so **bare repos on a NAS/USB/second disk work
  with no credentials**, and they power cheap full-loop integration tests (commit →
  push → clone → conflict → merge; no network, no mocks).

**V2:**

- `USER_PASS_PLAINTEXT` → git2's credential-helper support, which reads
  `credential.helper` from git config and runs it (`osxkeychain`, `manager`,
  `libsecret`/`store`). A one-time terminal `git push` stores the login where we read
  it. We *read* helpers, never write them.
- `DEFAULT` → default credentials (NTLM/Negotiate proxies; cheap to include).

### 3. SSH transport (V1)

Enable git2's `ssh` feature (vendored `libssh2`). libgit2 ≥ 1.5 enforces known_hosts
checking by default (post-CVE-2023-22742); we keep it and **do not** install a
permissive certificate check. An unknown host fails with a hint to connect once with
`ssh <host>`.

### 4. Adoption gating (V1)

Adopt when the repo is initialized and has a remote:

- **github remote** → still needs stored GitHub auth (else `disconnected`; the wizard
  is the fix).
- **generic remote** → adopt unconditionally. Missing local credentials surface as an
  auth error in the existing status UI and the engine retries on focus. No new states.

### 5. Existing-surface degradation audit (not new UI), V1

Some connected-state surfaces assumed GitHub:

- Status panel shows the bare remote URL; hides "View on GitHub" and the install link.
- `auth`-state recovery reopens the wizard for github; for generic it points at the
  terminal, since a sign-in cannot help.
- Public-repo confirmation is GitHub-API-only; generic remotes skip it (wiring your own
  remote is the opt-in). Documented loudly: `private: true` notes are in the backup and
  host visibility is the user's responsibility.
- The 95 MB file guard stays for all remotes (every host has a limit; ours mirrors
  GitHub's), without the "for GitHub" wording.

### 6. Restore on a new machine, V1 (docs only)

`git clone <url>`, then open the folder as a graph. Adoption picks up the remote and the
index rebuilds from files. Restore-from-GitHub stays GitHub-only.

## V1 phases (SSH + path remotes)

- **Phase 0, spike:** (a) a launchd-launched packaged app must see `SSH_AUTH_SOCK`
  (macOS's default agent uses a launchd socket; third-party agents like 1Password need a
  manual check). (b) Vendored libssh2 through sign/notarize and the Windows/Linux
  builds; record the binary-size delta.
- **Phase 1, Rust:** `ssh` feature, callback chain (agent + retry guard + HTTPS
  fail-fast), and an error-taxonomy pass so agent-miss, rejected key, and host-key
  failures land in `Auth`/`Network`, with negative tests. Full-loop tests over bare-path
  remotes with no token.
- **Phase 2, core TS + controller:** classification, token routing, adoption gating,
  status wording, the §5 audit. Tests: controller adopts a generic remote without GitHub
  auth; GitHub auth is never requested for generic remotes.
- **Phase 3, docs + validation:** "Use any git host (SSH)" recipe (init, add remote,
  confirm `ssh -T`); Plan 12's Deferred line points here; libraries.md gains libssh2.
  Manual matrix: GitLab.com SSH, Gitea in Docker SSH, bare path remote on an external
  volume, GHES SSH if reachable.

## V2 phases (HTTPS via credential helpers)

- **Phase 0, spike:** credential helpers from inside the GUI app on macOS (helpers
  resolve via `git` on a GUI-app `PATH`; CLT presence and helper discovery need proving,
  the same class of gotcha as the CLI sidecar). Git Credential Manager prompting on
  Windows (helpers may pop their own UI).
- **Phase 1, Rust:** helper + default credentials join the chain; a helper miss keeps a
  terminal hint ("run `git push` from a terminal once so the helper stores a login").
- **Phase 2, docs + validation:** HTTPS recipe (one-time `git push -u`). Matrix:
  GitLab.com HTTPS + osxkeychain, GHES HTTPS, Windows GCM.

## Failure cases

| Case | Behavior |
| --- | --- |
| No agent / key not added (V1) | `Auth` status error with the `ssh-add` / `ssh -T` hint. Engine retries on focus; nothing wedges. |
| Generic HTTPS remote (V1) | Immediate, clear error suggesting an SSH URL; no hang, no half-try. |
| Unknown SSH host key | Fail (no bypass) with the "connect once with `ssh <host>`" hint. |
| Helper prompts (GCM UI, V2) | Runs outside our process; worst case it shows its own dialog or fails → `Auth` with the terminal hint. Spike confirms osxkeychain never prompts. |
| Host rejects a push (protected branch, size, hooks) | Rejection message surfaces verbatim; non-FF retries merge-then-push. |
| Remote deleted / URL typo | Existing not-found/network mapping; retry on focus. |
| GitHub token near a generic remote | Never sent (§1). Local credentials are also never used for github.com; github remotes always use the managed token. |

## Deferred (beyond V2)

- Per-host token entry UI / keychain entries ("no terminal ever" for non-GitHub hosts).
- Default key-file fallback (`~/.ssh/id_ed25519`, `id_rsa`) if agent-only proves too
  strict; SSH passphrase prompting.
- Writing credentials back to helpers.
- GitLab/Gitea REST sugar behind the same one-module-per-host pattern as `github.ts`.
- `git://` and proxy edge cases beyond libgit2 defaults.
