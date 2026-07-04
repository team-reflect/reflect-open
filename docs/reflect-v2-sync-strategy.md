# Reflect V2 Sync Strategy

This document captures the current V2 sync direction. It focuses on a storage/sync adapter model, with AI-assisted conflict resolution sitting above the adapters.

It complements [Reflect V2 Product Vision](./reflect-v2-product-vision.md).

> **Status (2026-06-12) — what actually shipped in the first release** (see
> [Plan 12](./plans/12-backup-and-sync.md) and
> [Plan 16](./plans/16-generic-git-remotes.md), which supersede this doc where they
> differ):
>
> - **Git is the only sync backend.** GitHub via device-flow auth (token in the OS
>   keychain), plus generic git remotes over SSH (agent) and filesystem paths
>   (Plan 16 V1). HTTPS credential helpers are a later phase.
> - **File-sync folder providers (iCloud Drive/Dropbox/Drive) are unsupported for
>   sync by design** in the first wave — not adapters-in-waiting. The adapter
>   sections below are preserved as long-term direction only.
>   **Update (2026-07-04):** [Plan 21](./plans/21-icloud-drive-sync.md)
>   revises this — iCloud Drive is promoted to the primary consumer sync
>   path (app container + iCloud-first onboarding, marker-based conflict
>   surface); the AI-assisted resolution below remains deferred.
> - **AI-assisted conflict resolution did not ship.** Conflicts surface as standard
>   conflict markers; conflicted notes open protected, with a reviewable
>   mine/theirs/both resolution flow and a `has_conflict` "Needs review" projection.
> - Plain-language product states (Backed up / Backing up / Offline / Needs review /
>   Backup failed) shipped as described below.

## Strategy

Reflect V2 should treat sync as an adapter-backed capability, not as a single hard-coded backend.

The app should define a stable internal sync interface. Different adapters can implement that interface over time:

- Git repository backup and history.
- GitHub remote backup and multi-device sync.
- Local folder backup.
- iCloud Drive or OS-level file sync.
- Dropbox/Google Drive-style folder sync.
- Future protocol-based sync.

Git/GitHub should be treated as the first serious adapter target because it gives free backup, history, merge bases, and an open mental model. But Git should not leak into the product as commits, branches, rebases, remotes, or merge markers. The app should hide those mechanics behind plain product states.

Reflect should not host a sync API for the V2 core product. If an adapter needs a network service, it should talk directly from the app to a user-approved provider such as GitHub, a Git remote, iCloud Drive, Dropbox, Google Drive, or another open/protocol-based service. Reflect should own the local UX and adapter interface, not a proprietary server path.

The product should distinguish:

- **Backup**: user can recover data.
- **Sync**: multiple devices converge safely.
- **Collaboration**: multiple users edit shared content.

V2 first wave should commit to backup, local ownership, and a sync adapter boundary. A full multi-device sync implementation can remain TBD until the markdown file format, conflict model, and mobile story are clearer.

GitHub setup should let the user choose the repository. Reflect should not assume it owns a managed private repo, though it can guide repository setup, configure safe ignore defaults, and explain recovery behavior.

## Adapter Boundary

Adapters should translate provider-specific behavior into Reflect-native sync events.

An adapter should be responsible for:

- Detecting local file changes.
- Detecting remote/provider changes.
- Pulling or receiving changed file versions.
- Reporting sync progress.
- Reporting conflicts in a generic shape.
- Applying a resolved file or resolution plan.
- Preserving enough raw data for recovery.
- Creating local checkpoints before risky operations or background sync writes.

Adapters should not own markdown semantics, AI behavior, or final conflict-resolution policy. Those belong to Reflect's higher-level resolution layer.

## Generic Conflict Model

Every adapter should normalize native conflicts into a Reflect conflict model.

Conceptual interface:

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

This shape should be intentionally familiar to an AI model: a base version, a local version, and a remote version when available. If no base is available, the conflict becomes a two-way semantic merge.

Notes with `private: true` must not be sent to cloud AI for conflict resolution. If a locked note has a content conflict, Reflect should use local diff/review tooling or explicitly defer to manual resolution.

## Resolution Model

AI and UI should produce a resolution plan, not directly mutate adapter state.

Conceptual interface:

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

The adapter applies the accepted resolution. This keeps Git operations, iCloud duplicate cleanup, provider-specific sync writes, and local file writes behind the adapter boundary.

Every accepted resolution should be applied after a local checkpoint exists. This checkpoint is part of the recovery model, not a user-facing Git concept.

## AI-Assisted Conflict Resolution

Reflect should use AI to make sync conflicts humane.

Flow:

1. Adapter detects a conflict.
2. Adapter emits a `SyncConflict`.
3. Reflect parses the conflicting markdown versions into a structured diff.
4. The AI copilot proposes a merged markdown note when the note is not locked from cloud AI.
5. Reflect shows the proposed resolution as a reviewable patch.
6. User accepts, edits, or rejects the proposed resolution for note-body conflicts.
7. Adapter applies the accepted resolution after checkpointing.
8. Raw conflicting versions remain recoverable.

The AI prompt should treat conflicts as markdown merge problems:

- Preserve both devices' intent.
- Preserve headings, lists, backlinks, frontmatter, and links.
- Avoid deleting unique content unless clearly duplicated.
- Call out ambiguous choices.
- Require review for note-body conflicts.
- Allow automatic resolution only for trivial non-content conflicts, such as metadata-safe state updates or duplicate cleanup where no markdown body is changed.

AI conflict resolution should be a product layer above all adapters. Git may be the first beneficiary, but the same flow should be usable for iCloud Drive, folder sync, user-chosen provider sync, or future sync protocols.

## Git Adapter

A Git adapter can use normal Git mechanics internally while exposing a simple Reflect UX.

Possible implementation mapping:

- Git repository = workspace backup/sync container.
- User-chosen GitHub repository = backup/sync destination.
- Commit = internal checkpoint.
- Pull/fetch/merge = sync operation.
- Merge base / ours / theirs = `base`, `local`, `remote`.
- Merge conflict = `SyncConflict`.
- Accepted resolution = write merged file, mark resolved, create internal commit.

The product should not require the user to understand Git. Suggested user-facing states:

- `Backed up`
- `Syncing`
- `Needs review`
- `Resolved`
- `Backup failed`

Git remains valuable even if it is only used for backup/history at first. If AI-assisted resolution works well, Git can plausibly support consumer-grade sync without exposing Git complexity.

Reflect should create automatic checkpoints opportunistically after meaningful changes and before risky sync operations. It should avoid committing every save as a user-meaningful event because that would create noisy history and unnecessary sync churn.

GitHub credentials should live in per-device OS keychain or secure storage. They must not be written to markdown files, committed to Git, or stored in the ignored `.reflect/` directory unless a later security design explicitly replaces this default.

## iCloud Drive Adapter

iCloud Drive is attractive for Apple-first sync because it works with normal files and is built into macOS and iOS. Its conflict behavior is file-level, not markdown-aware.

An iCloud Drive adapter should expect conflicts such as:

- Duplicate files, for example `note.md` and `note 2.md`.
- Provider-managed file versions.
- Files that are not currently downloaded because of optimized storage.
- Rename/delete races.

Possible implementation mapping:

- Canonical markdown file = `local` or current version.
- Conflict duplicate or provider version = `remote`.
- Existing file version, if discoverable = `base`.
- Duplicate cleanup or version replacement = adapter-specific application of `ResolutionPlan`.

The same AI resolution layer can merge markdown intent. The adapter handles iCloud-specific file cleanup and recovery.

If the conflicting file is locked with `private: true`, the iCloud adapter should still normalize the conflict, but cloud AI must not receive the note content.

## Other Adapters

Other adapters should still emit the same normalized conflict model.

Examples:

- Local-folder adapter can copy snapshots and report file-level conflicts.
- Dropbox/Google Drive-style adapters can detect duplicate conflict files.
- Future protocol sync can map its native revisions into `base`, `local`, and `remote`.

The point is not that all adapters behave the same. The point is that Reflect should translate provider behavior into the same resolution workflow.

## UX Principles

Normal users should not see raw sync internals.

The UI should:

- Use plain state names.
- Offer "Review conflict" rather than "resolve merge".
- Show readable diffs.
- Let the user accept, edit, or reject AI resolutions.
- Keep original versions recoverable.
- Auto-resolve only trivial non-content conflicts.
- Require review for markdown body conflicts.
- Make provider/account setup understandable.

The AI can handle the first pass, but the user should remain in control when data loss is possible.

## Attachments And GitHub Guardrails

Attachments should be normal files under the workspace `assets/` directory and referenced from markdown with relative links. They should remain part of the user's portable data, not database blobs.

GitHub backup needs guardrails for large binaries. First-wave V2 should warn when attachments are likely to make GitHub backup slow, expensive, or unreliable. Git LFS, user-chosen object storage, or another binary sync adapter can be explored later, but they should not be required for the first GitHub adapter.

Generated indexes and local state under `.reflect/` should be ignored by GitHub backup by default.

## Open Questions

- How should Reflect authenticate GitHub without making setup feel developer-oriented?
- How should iCloud optimized-storage placeholders be handled for indexing and sync?
- What metadata is required in markdown frontmatter to make conflict resolution safer?
- Which trivial non-content conflicts are safe enough to auto-resolve?
- How should large binary attachments participate in future sync adapters?
- How should mobile apply resolutions if AI calls require user API keys?
- Should sync logs be user-visible, exportable, or only diagnostic?
