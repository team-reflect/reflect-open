//! Asset intake commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::fs::assets::UPLOAD_ID_HEADER;
use tauri::State;
use tauri::ipc::{InvokeBody, Request};

use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn asset_upload_begin(generation: u64, core: State<Arc<Core>>) -> AppResult<String> {
    core.asset_upload_begin(generation)
}

/// The chunk is the **raw request body** (`InvokeBody::Raw`) — never JSON —
/// and the upload id arrives in the `x-upload-id` header, since a raw-body
/// invoke carries no args.
#[tauri::command]
pub fn asset_upload_append(request: Request<'_>, core: State<Arc<Core>>) -> AppResult<()> {
    let id = request
        .headers()
        .get(UPLOAD_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::io(format!("missing {UPLOAD_ID_HEADER} header")))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::io(
            "asset_upload_append expects a raw binary body, got JSON",
        ));
    };
    core.asset_upload_append(id, bytes)
}

#[tauri::command(async)]
pub fn asset_upload_commit(
    id: String,
    desired_name: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<String> {
    core.asset_upload_commit(id, desired_name, generation)
}

#[tauri::command(async)]
pub fn asset_upload_commit_path(
    id: String,
    path: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.asset_upload_commit_path(id, path, generation)
}

#[tauri::command]
pub fn asset_upload_abort(id: String, core: State<Arc<Core>>) -> AppResult<()> {
    core.asset_upload_abort(id)
}

#[tauri::command]
pub async fn asset_import(
    source_path: String,
    desired_name: String,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<String> {
    core.asset_import(source_path, desired_name, generation)
        .await
}

#[tauri::command]
pub async fn audio_memo_import(
    source_path: String,
    path: String,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<()> {
    core.audio_memo_import(source_path, path, generation).await
}
