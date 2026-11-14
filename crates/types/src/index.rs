//! The note index's command arguments and results.

use serde::{Deserialize, Serialize};

/// One file the TS reconcile must read: its listed mtime doesn't match the
/// stored row (or is too fresh to trust), or it has no row at all. Stored
/// facts ride along so the reconcile needs no follow-up query — a `None`
/// hash marks an arrival (move-healing candidate).
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ScanCandidate {
    pub path: String,
    /// The file's listed on-disk mtime (epoch ms).
    pub modified_ms: u64,
    /// The stored row's mtime, or `None` when the path has no row.
    pub stored_mtime: Option<i64>,
    /// The stored row's content hash, or `None` when the path has no row.
    pub stored_hash: Option<String>,
}

/// A stored row whose file vanished from disk. Facts ride along because
/// id-based move healing pairs orphans with arrivals and, on a heal, the
/// moved row's hash decides whether the new path needs a re-index at all.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ScanOrphan {
    pub path: String,
    pub stored_mtime: i64,
    pub stored_hash: String,
}

/// The reconcile delta: what changed on disk relative to the index.
#[derive(Debug, Default, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ReconcileScan {
    /// Markdown files listed (eviction placeholders included).
    pub total: u64,
    pub candidates: Vec<ScanCandidate>,
    pub orphans: Vec<ScanOrphan>,
    /// Evicted files whose **content the index lacks**: no stored row (never
    /// indexed on this device), or a listed mtime differing from the stored
    /// row (a remote edit that synced while the file was evicted). The
    /// reconcile cannot read these — placeholders are never candidates — so
    /// it surfaces them for a *targeted* download request
    /// (`icloud_request_downloads`); the materialized file then arrives as an
    /// ordinary watcher upsert. Evicted files whose row is current are
    /// deliberately absent: re-downloading content we already indexed would
    /// fight the OS's eviction choice (Optimize Mac Storage). For legacy
    /// `.icloud` stubs the listed mtime is the stub's own, so an
    /// evicted-after-indexing note re-requests on each reconcile — matching
    /// mobile's existing download-all-pending-notes behavior on open/resume.
    pub stale_placeholders: Vec<String>,
}

/// A note's extracted projection, built in TS (Plan 03) and applied as one
/// row-set. Mirrors the `indexedNoteSchema` zod contract in
/// `packages/core/src/indexing/indexed-note.ts` field-for-field (serde
/// `rename_all = "camelCase"` matches the camelCase payload); a change on either
/// side must be mirrored on the other.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IndexedNote {
    pub path: String,
    pub id: Option<String>,
    pub title: String,
    pub title_key: String,
    /// ASCII-folded graph path: what a path-qualified link joins against.
    pub path_key: String,
    /// Derived from the path; templates are excluded from note surfaces.
    pub kind: NoteKind,
    pub daily_date: Option<String>,
    pub is_private: bool,
    pub is_pinned: bool,
    /// Explicit pin order (`pinned: <n>`); None for bare `pinned: true`.
    pub pinned_order: Option<f64>,
    /// The note is not blank: it has display text, or a body the FTS can match.
    pub has_content: bool,
    /// The published GitHub Gist's html url, when the note has one.
    pub gist_url: Option<String>,
    /// The body changed since it was last published to the gist.
    pub gist_stale: bool,
    pub file_hash: String,
    pub mtime: i64,
    pub text: String,
    /// Description text of referenced assets (Plan 20), folded into the FTS
    /// `body` only — never `preview` or anything AI-reachable.
    #[serde(default)]
    pub asset_text: String,
    /// The All Notes row snippet, derived once here rather than per query.
    pub preview: String,
    pub links: Vec<IndexedLink>,
    pub tags: Vec<IndexedTag>,
    pub aliases: Vec<IndexedAlias>,
    /// Every folded spelling this note answers to (see `note_claims`).
    pub claims: Vec<IndexedClaim>,
    /// Emails the note owns via `- Email:` contact-field bullets.
    pub emails: Vec<IndexedEmail>,
    pub assets: Vec<String>,
    /// Task rows for the Tasks projection (Plan 18).
    pub tasks: Vec<IndexedTask>,
}

/// What a note file is, from its path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum NoteKind {
    Daily,
    Note,
    Template,
}

impl NoteKind {
    /// The `notes.kind` column value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Note => "note",
            Self::Template => "template",
        }
    }
}

/// The syntax of a link: `[[wiki]]` or `[md](path)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Wiki,
    Md,
}

impl LinkKind {
    /// The `links.kind` column value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wiki => "wiki",
            Self::Md => "md",
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IndexedLink {
    pub kind: LinkKind,
    pub target_raw: String,
    /// Name key the link answers to: for wiki links, the folded name key
    /// (empty when the target has no name reading: a rooted path, `#self`, or
    /// a refused URI); for md links, the lowercased href.
    pub target_key: String,
    /// Folded vault path when the link names a file; None when it names a note.
    pub target_path_key: Option<String>,
    pub alias: Option<String>,
    pub pos_from: i64,
    pub pos_to: i64,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IndexedTag {
    /// Display casing (first-seen in the document).
    pub tag: String,
    /// Case-folded match key: what queries compare against.
    pub tag_key: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IndexedAlias {
    pub alias: String,
    pub alias_key: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IndexedClaim {
    /// Folded spelling this note answers to.
    pub key: String,
    /// One of the `claim_tier` constants in `reflect-index` (`CLAIM_TIER` in TS).
    pub tier: i64,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IndexedEmail {
    /// Display casing (as written in the field bullet).
    pub email: String,
    /// Case-folded match key: what resolution compares against.
    pub email_key: String,
}

/// One round task (Plan 18). `ast_path` is the task's address in the note
/// body's block AST (a JSON array of child indexes) and, with `note_path`, the
/// row's primary key.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IndexedTask {
    pub ast_path: String,
    /// The task's first paragraph as Markdown, marker excluded.
    pub markdown: String,
    /// The headings above the task, then its ancestor list items' first
    /// paragraphs, as Markdown, outermost first.
    #[serde(default)]
    pub breadcrumbs: Vec<String>,
    pub checked: bool,
    /// Explicit due date (first `[[YYYY-MM-DD]]` in the item), or None.
    pub due_date: Option<String>,
}

/// Path-derived addressing for a moved row: the folded destination path plus
/// the claims that derive from it. Folded in TypeScript — Rust never folds.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct MovedNoteAddress {
    pub path_key: String,
    pub basename_key: String,
    /// Set only for a calendar-valid `daily/YYYY-MM-DD.md` destination.
    pub daily_date: Option<String>,
}

/// One `touch` entry: re-stamp `path`'s stored mtime to `mtime` (epoch ms, as
/// listed by the file walk).
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
pub struct IndexTouch {
    pub path: String,
    pub mtime: i64,
}

/// One user-initiated move, with the folded addressing for both directions:
/// the destination's for the forward row move, the source's for the
/// compensating reverse move when the disk refuses.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteMoveRequest {
    pub from: String,
    pub to: String,
    pub to_address: MovedNoteAddress,
    pub from_address: MovedNoteAddress,
}

/// A conversation's metadata, sent with every message save so the row can be
/// created lazily on the first message. Mirrors the zod contract in
/// `packages/core/src/ai/chat/store.ts` field-for-field.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    pub id: String,
    pub title: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// One persisted exchange: the user message and everything the assistant did
/// in response. The JSON columns are opaque strings here — the TS store owns
/// their shapes and validates them on read.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRow {
    pub id: String,
    pub conversation_id: String,
    pub user_text: String,
    pub attachments: String,
    pub parts: String,
    pub response_messages: String,
    pub created_ms: i64,
}

/// One chunk of a note, built in TS (`@reflect/core` chunker). `vector` is
/// present only for new/changed chunks — `None` means "this chunk's hash
/// already has a row; keep its vector, refresh its metadata" (positions and
/// headings shift when text moves above an unchanged chunk).
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedChunk {
    pub heading: Option<String>,
    pub pos_from: i64,
    pub pos_to: i64,
    pub text: String,
    pub content_hash: String,
    pub model_id: String,
    pub vector: Option<Vec<f32>>,
}
