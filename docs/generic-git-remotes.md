# Back up to any git host (SSH)

Settings → Sync connects GitHub, or any HTTPS host with a username and a
token ("Other host"). For an SSH remote (GitLab, Gitea, Codeberg, your own
server) or a bare repo on a NAS, wire the remote yourself and Reflect's sync
loop adopts it (Plan 16).

The contract: **if `ssh -T git@host` works in your terminal, sync works.**
Reflect authenticates SSH remotes through your ssh-agent and never stores SSH
credentials. The managed GitHub sign-in is never sent anywhere but github.com.

## Recipe

```bash
cd /path/to/your/graph
git init -b main                                     # skip if it's already a repo
git remote add origin git@gitlab.com:you/notes.git   # any SSH remote
ssh -T git@gitlab.com   # confirms key auth works and records the host key
```

Then open (or refocus) the graph in Reflect. Settings → Sync shows the
remote, and sync runs the same as for GitHub.

A bare repo on another disk needs no credentials at all:

```bash
git init --bare /Volumes/NAS/notes.git
cd /path/to/your/graph && git remote add origin /Volumes/NAS/notes.git
```

## Restore on another machine

`git clone` the remote, then open the clone as a graph. The index rebuilds
from the files, and the remote is adopted automatically.

## When it fails

Failures surface in Settings → Sync (and the sidebar dot) and retry on
focus. Sync never wedges.

- **"the SSH agent offered no key this host accepts"**: `ssh-add` your key,
  confirm `ssh -T git@<host>` works, refocus Reflect.
- **Unknown host key**: connect once with `ssh <host>` so it lands in
  `~/.ssh/known_hosts`. Reflect never bypasses host-key verification.
- **HTTPS remote without a sign-in**: add one in Settings → Sync, or switch
  to the SSH URL with `git remote set-url origin git@host:owner/repo.git`.

**"Stop syncing"** drops the graph's `origin` (history stays). For a
hand-wired remote, the way back is the same `git remote add origin …`.

A hand-wired remote has no host API to check repository visibility, so
keeping the backup private is your responsibility. **Notes marked
`private: true` are included in the backup.**
