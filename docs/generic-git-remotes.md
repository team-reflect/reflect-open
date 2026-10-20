# Sync with any git host

GitHub.com goes through the guided flow: Settings → Sync → Git repository →
"Connect GitHub…". Every other git host works too: GitLab, Gitea, Forgejo,
Codeberg, GitHub Enterprise, your own server, or a bare repo on a NAS
(Plan 16, Plan 25).

## HTTPS: sign in from Settings

1. Open Settings → Sync → Git repository → "Another host…".
2. Enter the repository's `https://` URL, a username, and an access token.
3. Reflect checks the token against the host. If the check fails, nothing is
   stored.

Create the token on the host first:

- **GitLab:** a personal access token with the `write_repository` scope.
- **Gitea, Forgejo, Codeberg:** an access token with the `write:repository`
  permission.

The token lives only in the OS keychain, under the host's origin (scheme,
host, and port). Reflect sends it only to that origin. It never goes to
another host, even after a redirect. One sign-in serves every graph that uses
that host.

## SSH: use your ssh-agent

The contract: **if `ssh -T git@host` works in your terminal, sync works.**
Reflect authenticates SSH remotes through your ssh-agent. It never asks for,
stores, or manages SSH credentials.

```bash
cd /path/to/your/graph
git init -b main                                     # skip if it's already a repo
git remote add origin git@gitlab.com:you/notes.git   # any SSH remote
ssh -T git@gitlab.com   # confirms key auth works and records the host key
```

Then open (or refocus) the graph in Reflect. Settings → Sync shows the
remote. Edits sync a few moments after you stop typing. Pulls and merges run
on launch and focus. Conflicts merge through the same ladder as GitHub, and
the desktop app probes the remote every 90 seconds.

**Limitation:** the app's git engine is libgit2 with libssh2. It does not read
`~/.ssh/config`. Settings such as `sshCommand`, `IdentitiesOnly`, and per-host
`IdentityFile` have no effect. Load the key into the agent with `ssh-add`.

A bare repo on another disk needs no credentials at all:

```bash
git init --bare /Volumes/NAS/notes.git
cd /path/to/your/graph && git remote add origin /Volumes/NAS/notes.git
```

## Restore on another machine

```bash
git clone git@gitlab.com:you/notes.git ~/notes
```

…then open `~/notes` as a graph. The index rebuilds from the files, and the
remote is adopted automatically. For an HTTPS remote, add the sign-in in
Settings first.

## When it fails

Failures surface in Settings → Sync (and the sidebar dot) and retry on
focus. Sync never wedges.

- **"Sign-in needed"**: the graph has an HTTPS remote, but no sign-in is
  stored for that host. Settings shows an "Add sign-in…" button. Enter a
  username and a token. (The code calls this state `needsCredential`.)
- **"the SSH agent offered no key this host accepts"**: `ssh-add` your key,
  confirm `ssh -T git@<host>` works, refocus Reflect.
- **Unknown host key**: connect once with `ssh <host>` so it lands in
  `~/.ssh/known_hosts`. Reflect never bypasses host-key verification.

"Stop syncing" in Settings drops the graph's `origin` (history stays). It
keeps the host sign-in, because the sign-in belongs to the host and other
graphs may use it. For a hand-wired remote the way back is the same
`git remote add origin …` you started with.

One caution that the GitHub flow handles for you but a hand-wired remote
can't: there is no host API to check repository visibility, so keeping the
repository private is your responsibility. **Notes marked `private: true` are
included in what syncs.**
