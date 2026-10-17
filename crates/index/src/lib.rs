//! The graph's SQLite index (Plan 04), with no Tauri in it.
//!
//! `<graph>/.reflect/index.sqlite` is a rebuildable projection of the Markdown
//! files, backed by the bundled SQLite (FTS5 compiled in) with sqlite-vec
//! registered for Plan 09. Parsing happens in TS (`@reflect/core`); this crate
//! owns every write (one transaction per batch, gated on the session
//! generation in [`IndexSession`]), the read-only query bridge (`query.rs`),
//! the reconcile delta (`scan.rs`) and the durable `chat_*` tables
//! (`chat_write.rs`).
//!
//! The shell (a Tauri command, a uniffi export, a wasm binding) decides the
//! thread each call runs on and how `index:written` reaches the frontend;
//! the session only reports whether a write committed.

mod chat_write;
#[cfg(any(feature = "native", test))]
mod connections;
mod embed_write;
mod query;
mod scan;
mod session;
#[cfg(test)]
mod tests;
mod write;

pub use chat_write::{ChatConversation, ChatMessageRow};
#[cfg(any(feature = "native", test))]
pub use connections::FileIndexConnections;
pub use embed_write::EmbeddedChunk;
pub use scan::{ReconcileScan, ScanCandidate, ScanOrphan};
pub use session::{Applied, IndexConnections, IndexSession, IndexTouch, NoteMoveRequest};
pub use write::{IndexedNote, MovedNoteAddress};
