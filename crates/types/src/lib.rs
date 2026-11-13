//! Types that cross the Rust / TypeScript / Swift boundary, shared by every
//! Rust crate.
//!
//! Nothing here depends on Tauri or on a platform. The serde shapes are the
//! wire contract: `pnpm gen:types` (the `codegen` feature) generates
//! `@reflect/types` and the `TypesShared` Swift module from them.

mod change;
mod error;
pub mod events;
mod file_meta;

pub use change::{ChangeKind, FileChange};
pub use error::{AppError, AppResult};
pub use file_meta::FileMeta;
