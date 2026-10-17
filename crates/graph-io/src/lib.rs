//! Graph file IO with no Tauri in it: the open graph session, atomic note
//! writes, the traversal guard, the per-graph lock, the Reflect V1 import,
//! the X archive store and the conflict ladder. The shell decides the thread,
//! the trash policy and how a change reaches the frontend.

pub mod conflict;
mod graph;
pub mod graph_gitignore;
mod graph_lock;
pub mod hash;
pub mod import;
pub mod import_assets;
pub mod io;
pub mod own_writes;
mod resolve;
pub mod x_archive_store;

pub use graph::*;
#[cfg(any(test, feature = "test-support"))]
pub use graph_lock::holders as graph_lock_holders;
pub use graph_lock::with_graph_lock;
pub use resolve::{ensure_relative, resolve};
