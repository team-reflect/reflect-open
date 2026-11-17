//! The graph's SQLite index (Plan 04), with no Tauri in it.
//!
//! `<graph>/.reflect/index.sqlite` is a rebuildable projection of the Markdown
//! files, backed by the bundled SQLite (FTS5 compiled in) with sqlite-vec
//! registered for Plan 09. Parsing happens in TS (`@reflect/core`); this crate
//! owns every write (one transaction per batch, gated on the session
//! generation in [`IndexSession`]), every read query (`read/`), the reconcile
//! delta (`scan.rs`) and the durable `chat_*` tables (`chat_write.rs`).
//!
//! The shell (a Tauri command, a uniffi export, a wasm binding) decides the
//! thread each call runs on and how `index:written` reaches the frontend;
//! the session only reports whether a write committed.

mod chat_write;
mod commands;
#[cfg(any(feature = "native", test))]
mod connections;
mod embed_write;
mod query;
pub mod read;
mod scan;
mod session;
#[cfg(test)]
mod tests;
pub mod text;
mod write;

pub use commands::{
    INDEX_READ_COMMANDS, INDEX_WRITE_COMMANDS, IndexCommands, IndexEvents, is_index_command,
};
#[cfg(any(feature = "native", test))]
pub use connections::FileIndexConnections;
pub use query::run_query;
pub use session::{Applied, IndexConnections, IndexSession};
