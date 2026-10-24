# Sync with any git host

GitHub.com goes through the guided flow: Settings → Sync → Git repository →
"Connect a repository…", then GitHub. Every other git host works too: GitLab,
Gitea, Forgejo, Codeberg, GitHub Enterprise, your own server, or a bare
repository on a NAS (Plan 16, Plan 25). An HTTPS address goes through the
same dialog, as "Other host". An SSH or path remote is wired by hand.

## HTTPS: sign in from Settings

1. Open Settings → Sync → Git repository → "Connect a repository…" and choose
   "Other host".
2. Enter the repository's `https://` address, a username, and an access token
   or password.
3. Reflect checks the sign-in with the host before it stores anything. A
   refused sign-in shows the host's answer, and nothing is stored.

Create the token on the host first:

- **GitLab:** a personal or project access token with the `write_repository`
  scope. GitLab refuses account passwords for git over HTTPS.
- **Gitea, Forgejo, Codeberg:** an access token with the `write:repository`
  permission.
- **A server with HTTP Basic auth over HTTPS:** your account password works as
  is. Plain `http://` never gets a sign-in.

The sign-in lives only in the OS keychain, under the host's origin (scheme,
host, and port). Reflect sends it only to that origin: never to another
host, even after a redirect, and never over plain `http://`. One sign-in
serves every graph on that host, and "Stop syncing" keeps it.

A remote whose sign-in is missing shows "Sign-in needed" on the Git
repository card, with "Add sign-in…". A sign-in the host refused shows
"Update sign-in…". Both keep the remote and the branch as they are.

## SSH: use your ssh-agent

The contract: **if `ssh -T git@host` works in your terminal with the key
loaded in your agent, sync works.** Reflect authenticates SSH remotes
through your ssh-agent only; `ssh-add -l` must list the key the host
accepts. It never asks for, stores, or manages SSH credentials.

SSH remotes are desktop only. iOS has no ssh-agent, so on the phone connect
over HTTPS from Settings.

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

A bare repository on another disk needs no credentials at all:

```bash
git init --bare /Volumes/NAS/notes.git
cd /path/to/your/graph && git remote add origin /Volumes/NAS/notes.git
```

## Restore on another machine

```bash
git clone git@gitlab.com:you/notes.git ~/notes
```

…then open `~/notes` as a graph. The index rebuilds from the files, and the
remote is adopted automatically. For an HTTPS remote, the Git repository card
asks for the sign-in once the graph is open.

## When it fails

Failures surface in Settings → Sync (and the sidebar dot) and retry on
focus. Sync never wedges.

- **"Sign-in needed"**: the graph has an HTTPS remote, but no sign-in is
  stored for that host. Use "Add sign-in…" and enter a username and a token
  or password. (The code calls this state `needsCredential`.)
- **"the SSH agent offered no key this host accepts"**: `ssh-add` your key,
  confirm `ssh -T git@<host>` works, refocus Reflect.
- **Unknown host key**: connect once with `ssh <host>` so it lands in
  `~/.ssh/known_hosts`. Reflect never bypasses host-key verification.
- **A plain `http://` remote**: Reflect does not send sign-ins over plain
  http. Use the repository's `https://` address.

"Stop syncing" in Settings drops the graph's `origin` (history stays). It
keeps the host sign-in, because the sign-in belongs to the host and other
graphs may use it. For a hand-wired remote the way back is the same
`git remote add origin …` you started with.

One caution that the GitHub flow handles for you but a hand-wired remote
can't: there is no host API to check repository visibility, so keeping the
repository private is your responsibility. **Notes marked `private: true` are
included in what syncs.**
