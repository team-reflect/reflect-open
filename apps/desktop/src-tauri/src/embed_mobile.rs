//! Mobile stand-in for the embedding runtime (Plan 19): semantic search is
//! desktop-only in the first mobile wave — fastembed/ONNX Runtime is not
//! built for iOS/Android, and mobile search is lexical (FTS5). The commands
//! stay registered so the IPC surface is identical on every platform, but
//! every call fails loudly: the mobile frontend never mounts the
//! embeddings-sync surface, so reaching one of these is a bug.

use crate::error::{AppError, AppResult};

/// Unit stand-in for the desktop runtime state, so `lib.rs` manages the same
/// type name on every platform.
#[derive(Default)]
pub struct EmbedState;

fn desktop_only<T>() -> AppResult<T> {
    Err(AppError::Unknown {
        message: "the embedding runtime is desktop-only".into(),
    })
}

/// Desktop-only; fails loudly on mobile.
#[tauri::command]
pub fn embed_status() -> AppResult<()> {
    desktop_only()
}

/// Desktop-only; fails loudly on mobile.
#[tauri::command]
pub fn embed_ensure() -> AppResult<()> {
    desktop_only()
}

/// Desktop-only; fails loudly on mobile.
#[tauri::command]
pub fn embed_texts() -> AppResult<()> {
    desktop_only()
}
