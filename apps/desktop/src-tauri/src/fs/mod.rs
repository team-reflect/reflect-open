//! Graph file-IO commands, forwarded to [`reflect_core::Core`], plus the
//! graph helpers the shell's other modules share.

pub mod asset_protocol;
pub mod assets;
pub mod x_archive;
pub mod x_media_protocol;
pub mod x_syndication;

use std::sync::Arc;

use reflect_core::Core;
use tauri::State;

use crate::error::AppResult;

pub use reflect_graph_io::*;
pub use reflect_types::FileMeta;

use reflect_graph_io::import;

#[tauri::command]
pub fn graph_create(path: String, core: State<Arc<Core>>) -> AppResult<GraphInfo> {
    core.graph_create(path)
}

#[tauri::command]
pub async fn graph_import_reflect_v1_zip(
    path: String,
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<import::ImportSummary> {
    core.graph_import_reflect_v1_zip(path, generation).await
}

#[tauri::command]
pub fn graph_import_cancel(core: State<Arc<Core>>) {
    core.graph_import_cancel();
}

#[tauri::command]
pub fn graph_open(path: String, core: State<Arc<Core>>) -> AppResult<GraphInfo> {
    core.graph_open(path)
}

#[tauri::command]
pub async fn note_read(
    path: String,
    generation: Option<u64>,
    core: State<'_, Arc<Core>>,
) -> AppResult<String> {
    core.note_read(path, generation).await
}

#[tauri::command]
pub async fn note_read_local(
    path: String,
    generation: Option<u64>,
    core: State<'_, Arc<Core>>,
) -> AppResult<LocalNoteRead> {
    core.note_read_local(path, generation).await
}

#[tauri::command(async)]
pub fn note_write(
    path: String,
    contents: String,
    generation: u64,
    check_contents: Option<bool>,
    expected_contents: Option<String>,
    core: State<Arc<Core>>,
) -> AppResult<NoteWriteOutcome> {
    core.note_write(
        path,
        contents,
        generation,
        check_contents,
        expected_contents,
    )
}

#[tauri::command(async)]
pub fn note_create(
    path: String,
    contents: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<NoteCreateOutcome> {
    core.note_create(path, contents, generation)
}

#[tauri::command(async)]
pub fn asset_write(
    path: String,
    contents_base64: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.asset_write(path, contents_base64, generation)
}

#[tauri::command(async)]
pub fn audio_memo_delete(path: String, generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.audio_memo_delete(path, generation)
}

#[tauri::command]
pub fn transcript_cache_read(
    name: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<String> {
    core.transcript_cache_read(name, generation)
}

#[tauri::command]
pub fn transcript_cache_write(
    name: String,
    contents: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.transcript_cache_write(name, contents, generation)
}

#[tauri::command]
pub fn asset_read_binary(
    path: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(
        core.asset_read_binary(path, generation)?,
    ))
}

#[tauri::command]
pub fn asset_read(path: String, generation: u64, core: State<Arc<Core>>) -> AppResult<String> {
    core.asset_read(path, generation)
}

#[tauri::command]
pub fn asset_open(path: String, generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.asset_open(path, generation)
}

#[tauri::command]
pub fn asset_reveal(path: String, generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.asset_reveal(path, generation)
}

#[tauri::command]
pub fn dir_list(dir: String, generation: u64, core: State<Arc<Core>>) -> AppResult<Vec<FileMeta>> {
    core.dir_list(dir, generation)
}

#[tauri::command]
pub fn note_exists(path: String, core: State<Arc<Core>>) -> AppResult<bool> {
    core.note_exists(path)
}

#[tauri::command(async)]
pub fn note_delete(path: String, generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.note_delete(path, generation)
}

#[tauri::command(async)]
pub fn graph_delete(generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.graph_delete(generation)
}

#[tauri::command]
pub async fn list_files(
    generation: Option<u64>,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<FileMeta>> {
    core.list_files(generation).await
}

#[tauri::command]
pub async fn list_attachments(
    generation: Option<u64>,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<FileMeta>> {
    core.list_attachments(generation).await
}

#[tauri::command]
pub fn vault_scan_stats(
    generation: Option<u64>,
    core: State<Arc<Core>>,
) -> AppResult<VaultScanStats> {
    core.vault_scan_stats(generation)
}
