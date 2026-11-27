//! Small helpers shared by Reflect's Rust crates, the Rust counterpart of
//! `packages/utils`. A helper belongs here when it has no domain state and
//! more than one crate needs it.

mod hash;
mod note_text;

pub use hash::{hex, sha256_hex};
pub use note_text::{normalize_line_endings, note_hash};
