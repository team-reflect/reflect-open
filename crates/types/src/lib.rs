//! Types that cross the Rust / TypeScript / Swift boundary, shared by every
//! Rust crate, and the command table.
//!
//! Nothing here depends on Tauri or on a platform. The serde shapes are the
//! wire contract: `pnpm gen:types` (the `codegen` feature) generates
//! `@reflect/types` and the `TypesShared` Swift module from them.

mod change;
mod contacts;
mod embed;
mod error;
pub mod events;
mod file_meta;
mod git;
mod graph;
mod icloud;
mod import;
mod index;
mod link_preview;
mod settings;
mod skill;

pub use change::{ChangeKind, FileChange};
pub use contacts::{ContactMatch, ContactsAuthorization};
pub use embed::{EmbedProgress, EmbedStatus};
pub use error::{AppError, AppResult};
pub use file_meta::FileMeta;
pub use git::{
    ChangedFile, CommitOutcome, GitCredential, GitStatus, MergeKind, PullOutcome, PushOutcome,
    RemoteDelta, RemoteTip, SkippedFile,
};
pub use graph::{
    GraphInfo, LocalNoteRead, NoteCreateOutcome, NoteWriteOutcome, RecentGraph, VaultScanStats,
    WindowBootstrap,
};
pub use icloud::{IcloudStatus, IcloudSweepOutcome, MobileStorageInfo, SweepScope};
pub use import::{GraphImportProgress, GraphImportStage, GraphImportSummary};
pub use index::{
    ChatConversation, ChatMessageRow, EmbeddedChunk, IndexTouch, IndexedAlias, IndexedClaim,
    IndexedEmail, IndexedLink, IndexedNote, IndexedTag, IndexedTask, MovedNoteAddress,
    NoteMoveRequest, ReconcileScan, ScanCandidate, ScanOrphan,
};
pub use link_preview::LinkPreviewHtml;
pub use settings::SettingsDoc;
pub use skill::{AgentSkillInstallState, AgentSkillStatus};
