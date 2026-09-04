# Back up to any git host (SSH)

GitHub gets the guided in-app flow (Settings → Backup → Connect GitHub…).
Every other git host — GitLab, Gitea, Codeberg, GitHub Enterprise, your own
server, a bare repo on a NAS — works with zero UI: wire the remote yourself
and Reflect's sync loop adopts it (Plan 16).

The contract: **if `ssh -T git@host` works in your terminal, sync works.**
Reflect authenticates SSH remotes through your ssh-agent — it never asks for,
stores, or manages credentials for non-GitHub hosts, and the managed GitHub
sign-in is never sent anywhere but github.com. HTTPS URLs for non-GitHub
hosts aren't supported yet (that's Plan 16 V2, via git credential helpers) —
use the SSH form.

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
focus. See [Git backup and recovery](./git-backup-safety.md) for save ordering,
conflict copies, runtime exclusion, and interrupted operations.

- **"the SSH agent offered no key this host accepts"** — `ssh-add` your key,
  confirm `ssh -T git@<host>` works, refocus Reflect.
- **Unknown host key** — connect once with `ssh <host>` so it lands in
  `~/.ssh/known_hosts`. Reflect never bypasses host-key verification.
- **HTTPS remote** — refused at adoption with this same advice: switch it to
  the SSH URL, `git remote set-url origin git@host:owner/repo.git`.

One more terminal-side fact: **"Stop backing up"** in Settings drops the
graph's `origin` (history stays). For a hand-wired remote the way back is the
same `git remote add origin …` you started with.

One caution that the GitHub flow handles for you but a hand-wired remote
can't: there is no host API to check repository visibility, so keeping the
backup private is your responsibility — **notes marked `private: true` are
included in the backup**.
