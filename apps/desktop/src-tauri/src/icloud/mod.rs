//! iCloud Drive integration (Plan 21): storage roots, conflict detection and
//! resolution, and live change watching.
//!
//! - [`storage`] — container discovery, graph-dir resolution, and download
//!   nudges for `.icloud` placeholders (shipped with the Phase 1 iOS leg).
//! - [`versions`] — the `NSFileVersion` surface: list a file's unresolved
//!   conflict versions, and mark them resolved once handled.
//! - [`sweep`] — the conflict sweep: run every conflicted note through the
//!   deterministic resolution ladder ([`crate::conflict`]), archive the
//!   losing versions, fold creation-collision duplicates (`name 2.md`) back
//!   into their canonical file, and keep the shadow base advancing.
//! - [`watch`] — an `NSMetadataQuery` over the graph: the sole external
//!   change source on iOS (there is no file watcher there), and the conflict
//!   signal on both Apple platforms (a conflict version appearing does not
//!   necessarily touch the file, so the desktop `notify` watcher alone would
//!   miss it).
//!
//! Platform shape mirrors `contacts.rs`: real implementations on Apple
//! targets, honest "no iCloud here" stubs elsewhere, commands registered on
//! every platform so the IPC surface never branches.

// Public modules, not re-exported functions: `generate_handler!` resolves a
// command's hidden `__cmd__` companion macro at the same path as the
// function, which a `pub use` does not carry.
pub mod storage;
pub mod sweep;
pub mod versions;
pub mod watch;
