# Back up to any git host

GitHub gets the guided in-app flow (Settings → Backup → Connect GitHub…).
Every other git host — GitLab, Gitea, Codeberg, GitHub Enterprise, your own
server, a bare repo on a NAS — connects one of two ways.

## In the app (HTTPS)

Settings → Backup → **Connect another host…** (on iOS: Settings → Backup →
Connect another host) asks for the repository's `https://` URL, a username,
and a personal access token with write access to the repository. Reflect
checks the sign-in against the host before storing anything, so a wrong URL
or token fails right there with the host's own answer. The token lives in
the OS keychain under that host and is sent nowhere else; the managed GitHub
sign-in is never sent anywhere but github.com.

## In the terminal (SSH)

The contract: **if `ssh -T git@host` works in your terminal, sync works.**
Reflect authenticates SSH remotes through your ssh-agent — it never asks for,
stores, or manages SSH credentials.

## Recipe

```bash
cd /path/to/your/graph
git init -b main                                     # skip if it's already a repo
git remote add origin git@gitlab.com:you/notes.git   # any SSH remote
ssh -T git@gitlab.com   # confirms key auth works and records the host key
```

Then open (or refocus) the graph in Reflect. Settings → Backup shows the
remote, edits back up automatically a few moments after you stop typing, and
pulls/merges run on launch and focus — conflict handling included, same as
GitHub.

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
remote is adopted automatically.

## When it fails

Failures surface in Settings → Backup (and the sidebar dot) and retry on
focus — sync never wedges.

- **"the SSH agent offered no key this host accepts"** — `ssh-add` your key,
  confirm `ssh -T git@<host>` works, refocus Reflect.
- **Unknown host key** — connect once with `ssh <host>` so it lands in
  `~/.ssh/known_hosts`. Reflect never bypasses host-key verification.
- **HTTPS remote** — needs a sign-in stored for that host (a username and a
  token, kept in the OS keychain); until one exists, adoption is refused
  with that advice, or switch the remote to its SSH URL,
  `git remote set-url origin git@host:owner/repo.git`.

One more terminal-side fact: **"Stop backing up"** in Settings drops the
graph's `origin` (history stays). For a hand-wired remote the way back is the
same `git remote add origin …` you started with.

One caution that the GitHub flow handles for you but a hand-wired remote
can't: there is no host API to check repository visibility, so keeping the
backup private is your responsibility — **notes marked `private: true` are
included in the backup**.
