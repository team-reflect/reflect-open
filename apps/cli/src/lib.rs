//! `reflect` — scriptable access to a Reflect graph.
//!
//! Self-contained: reads and atomically mutates the graph's markdown files
//! directly and opens `.reflect/index.sqlite` strictly read-only — no Node
//! runtime, running desktop app, or IPC required. The desktop watcher picks up
//! mutations while the app is open; the next app open reconciles them
//! otherwise. Read-side modules mirror the small contract owned by
//! `@reflect/core` and are parity-tested against the same fixtures.
//!
//! Privacy contract: notes with `private: true` frontmatter are invisible and
//! immutable through this CLI, with no override flag. The resolved file's own
//! frontmatter is checked, never just the index row, so a stale index cannot
//! leak or mutate a just-flagged note.

pub mod commands;
pub mod error;
pub mod frontmatter;
pub mod graph;
pub mod hash;
pub mod index;
pub mod keys;
pub mod mutation;
pub mod note_file;
pub mod paths;
pub mod resolve;
pub mod search;
pub mod slug;
