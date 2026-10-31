# Reflect V2 Sync Strategy

The V2 sync direction: a storage/sync adapter model, with AI-assisted conflict resolution above
the adapters. It complements [Reflect V2 Product Vision](./reflect-v2-product-vision.md).

> **Status: what shipped** ([Plan 12](./plans/12-backup-and-sync.md),
> [Plan 16](./plans/16-generic-git-remotes.md), and [Plan 21](./plans/21-icloud-drive-sync.md)
> supersede this doc where they differ):
>
> - **Git** (2026-06-12): GitHub via device-flow auth (token in the OS keychain), plus generic
>   git remotes over SSH (agent) and filesystem paths. HTTPS credential helpers are a later
>   phase.
> - **iCloud Drive** (2026-07-04): the first release left file-sync folders unsupported by
>   design. Plan 21 then shipped iCloud Drive as the primary consumer sync path, with a
>   deterministic on-device resolution ladder ending in a word-level merge
>   ([icloud-sync.md](./icloud-sync.md)). A graph syncs via iCloud *or* a Git remote (one method
>   per graph recommended). Dropbox/Drive adapters remain long-term direction only.
> - **AI-assisted conflict resolution did not ship.** Conflicts resolve on-device (see
>   [git-backup-safety.md](./git-backup-safety.md), S7 and S9).
> - The plain-language states (Backed up / Backing up / Offline / Backup failed) shipped as
>   described below.

## Strategy

Sync is an adapter-backed capability, not one hard-coded backend. A stable internal sync
interface can have many adapters over time: Git backup and history, GitHub multi-device sync, a
local folder, iCloud Drive, Dropbox/Google Drive-style folders, and future protocols.

Git/GitHub is the first serious target: it gives free backup, history, merge bases, and an open
mental model. But Git must not leak into the product as commits, branches, rebases, remotes, or
merge markers. Plain product states hide them.

Reflect hosts no sync API for the V2 core. An adapter that needs a network service talks
directly to a user-approved provider. Reflect owns the local UX and the adapter interface, not a
proprietary server path.

The product distinguishes **backup** (the user can recover data), **sync** (devices converge
safely), and **collaboration** (several users edit shared content). The first wave commits to
backup, local ownership, and the adapter boundary. Full multi-device sync waits until the file
format, conflict model, and mobile story are clearer.

The user chooses the GitHub repository. Reflect does not assume it owns a managed repo, but it
can guide setup, set safe ignore defaults, and explain recovery.

## Adapter Boundary

Adapters translate provider behavior into Reflect-native sync events. An adapter detects local
and remote changes, pulls changed versions, reports progress, reports conflicts in a generic
shape, applies a resolved file or plan, keeps enough raw data for recovery, and makes local
checkpoints before risky operations or background writes.

Adapters do not own markdown semantics, AI behavior, or the final resolution policy. Those
belong to the resolution layer above.

## Generic Conflict Model

Every adapter normalizes native conflicts into one model:

```ts
interface SyncConflict {
  id: string
  notePath: string
  kind: ConflictKind
  adapterId: SyncAdapterId
  base?: NoteVersion
  local: NoteVersion
  remote: NoteVersion
  raw: unknown
}

type ConflictKind =
  | 'content'
  | 'rename'
  | 'delete-edit'
  | 'metadata'
  | 'binary'
  | 'unknown'

type SyncAdapterId = 'git' | 'github' | 'icloud-drive' | 'local-folder' | string

interface NoteVersion {
  label: string
  markdown: string
  modifiedAt?: string
  deviceName?: string
  revisionId?: string
}
```

The base/local/remote shape is familiar to an AI model. Without a base, the conflict becomes a
two-way semantic merge.

`private: true` notes must not go to cloud AI for resolution. For those, Reflect uses local
diff/review tools or defers to manual resolution.

## Resolution Model

AI and UI produce a resolution plan. They never mutate adapter state directly:

```ts
interface ResolutionPlan {
  conflictId: string
  mergedMarkdown: string
  summary: string
  confidence: 'high' | 'medium' | 'low'
  requiresReview: boolean
  warnings: string[]
}
```

The adapter applies the accepted plan, so Git operations, iCloud duplicate cleanup, and file
writes stay behind the boundary. Every accepted resolution is applied after a local checkpoint
exists. The checkpoint is part of recovery, not a user-facing Git concept.

## AI-Assisted Conflict Resolution

AI makes sync conflicts humane:

1. The adapter detects a conflict and emits a `SyncConflict`.
2. Reflect parses the versions into a structured diff.
3. The AI proposes merged markdown, if the note is not locked from cloud AI.
4. Reflect shows it as a reviewable patch. The user accepts, edits, or rejects note-body
   resolutions.
5. The adapter applies the accepted plan after checkpointing. Raw versions stay recoverable.

The prompt treats conflicts as markdown merges: keep both devices' intent; keep headings, lists,
backlinks, frontmatter, and links; do not delete unique content unless clearly duplicated; call
out ambiguous choices. Note-body conflicts always need review. Only trivial non-content
conflicts (metadata-safe updates, duplicate cleanup with no body change) may auto-resolve.

This layer sits above all adapters: Git may benefit first, but iCloud, folder sync, and future
protocols use the same flow.

## Git Adapter

Git mechanics stay internal behind a simple UX:

- Repository = backup/sync container; user-chosen GitHub repository = destination.
- Commit = internal checkpoint. Pull/fetch/merge = sync.
- Merge base / ours / theirs = `base`, `local`, `remote`. A merge conflict = `SyncConflict`.
- Accepted resolution = write the merged file, mark resolved, commit internally.

Suggested user-facing states: `Backed up`, `Syncing`, `Needs attention`, `Resolved`,
`Backup failed`.

Git is valuable even as backup/history only. If AI resolution works well, Git could support
consumer-grade sync without exposing its complexity.

Checkpoint after meaningful changes and before risky sync operations, not on every save: that
would make noisy history and sync churn.

GitHub credentials live in the per-device OS keychain. They must never be written to markdown,
committed to Git, or stored in `.reflect/`, unless a later security design replaces this
default.

## iCloud Drive Adapter

> **Shipped (2026-07-04)** as [Plan 21](./plans/21-icloud-drive-sync.md): most conflicts resolve
> deterministically on-device (diff3 over shadow bases, daily append-union, a word-level merge
> last), with AI still deferred. [icloud-sync.md](./icloud-sync.md) is the current contract.
> This section keeps the original reasoning.

iCloud Drive suits Apple-first sync: normal files, built into macOS and iOS. But its conflict
behavior is file-level, not markdown-aware. Expect duplicate files (`note.md` and `note 2.md`),
provider-managed versions, files not downloaded because of optimized storage, and rename/delete
races.

Mapping: the canonical file = `local`; the conflict duplicate or provider version = `remote`; an
existing file version, if discoverable = `base`; duplicate cleanup or version replacement = the
adapter's way to apply a `ResolutionPlan`. The shared AI layer merges intent, and the adapter
handles iCloud cleanup and recovery. A `private: true` conflict is still normalized, but cloud
AI never sees its content.

## Other Adapters

Other adapters emit the same model: a local-folder adapter copies snapshots and reports
file-level conflicts, Dropbox/Google Drive-style adapters detect duplicate conflict files, and
future protocols map their revisions to `base`, `local`, and `remote`. Adapters differ; the
resolution workflow does not.

## UX Principles

Normal users never see raw sync internals. Use plain state names and "Review conflict," not
"resolve merge." Show readable diffs. Let the user accept, edit, or reject AI resolutions. Keep
original versions recoverable. Auto-resolve only trivial non-content conflicts. Make provider
setup understandable. The AI does the first pass, but the user stays in control when data loss
is possible.

## Attachments And GitHub Guardrails

Attachments are normal files under `assets/`, linked from markdown with relative links. They are
portable user data, not database blobs.

Large binaries need guardrails: the first wave warns when attachments are likely to make GitHub
backup slow, expensive, or unreliable. Git LFS, user-chosen object storage, or a binary adapter
can come later, but the first GitHub adapter must not need them. `.reflect/` is ignored by
backup by default.

## Open Questions

- How should Reflect authenticate GitHub without making setup feel developer-oriented?
- How should iCloud optimized-storage placeholders be handled for indexing and sync?
- What frontmatter metadata would make conflict resolution safer?
- Which trivial non-content conflicts are safe to auto-resolve?
- How should large binary attachments join future sync adapters?
- How should mobile apply resolutions if AI calls need user API keys?
- Should sync logs be user-visible, exportable, or only diagnostic?
