//! `reflect` — read/discovery CLI over a Reflect graph (Plan 14).
//!
//! Self-contained: reads the graph's markdown files directly and opens
//! `.reflect/index.sqlite` strictly read-only — no Node runtime, no running
//! desktop app, no IPC. The modules mirror the small read-side contract owned
//! by `@reflect/core` (paths, fold keys, frontmatter, title derivation,
//! hashing, FTS match syntax); each one names its TS counterpart and is
//! parity-tested against the same expected values. Keep this surface frozen —
//! the CLI must never grow its own parser or indexer beyond it.
//!
//! Privacy contract: notes with `private: true` frontmatter are invisible
//! through this CLI — excluded from `search`, refused by `show`/`today`/`path`
//! — with no override flag. The resolved file's own frontmatter is checked,
//! never just the index row, so a stale index can't leak a just-flagged note.

pub mod commands;
pub mod error;
pub mod frontmatter;
pub mod graph;
pub mod hash;
pub mod index;
pub mod keys;
pub mod note_file;
pub mod paths;
pub mod resolve;
pub mod search;
