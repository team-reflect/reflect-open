//! Types that cross the Rust / TypeScript boundary, shared by every Rust crate.
//!
//! Nothing here depends on Tauri or on a platform. The serde shapes are the
//! contract the frontend validates with zod, so a change here is a change to
//! `@reflect/core`.

mod change;
mod error;
pub mod events;
mod file_meta;
#[cfg(test)]
mod wire_tests;

pub use change::{ChangeKind, FileChange};
pub use error::{AppError, AppResult};
pub use file_meta::FileMeta;
