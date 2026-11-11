//! The SQLite index commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use serde_json::{Map, Value};
use tauri::State;

use crate::error::AppResult;

pub use reflect_index::{
    ChatConversation, ChatMessageRow, EmbeddedChunk, IndexSession as IndexState, IndexTouch,
    IndexedNote, MovedNoteAddress, NoteMoveRequest, ReconcileScan,
};

/// The open index session's generation as a pure read, or `None` when no
/// index is open. The note-window bootstrap (`windows::window_bootstrap`)
/// adopts the session through this.
pub(crate) fn current_generation(index: &IndexState) -> AppResult<Option<u64>> {
    index.current_generation()
}

#[tauri::command]
pub fn index_open(core: State<Arc<Core>>) -> AppResult<u64> {
    core.index_open()
}

#[tauri::command]
pub fn index_apply(note: IndexedNote, generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.index_apply(note, generation)
}

#[tauri::command]
pub fn index_apply_batch(
    notes: Vec<IndexedNote>,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.index_apply_batch(notes, generation)
}

#[tauri::command]
pub fn index_remove(path: String, generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.index_remove(path, generation)
}

#[tauri::command(async)]
pub fn note_move_indexed(
    request: NoteMoveRequest,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.note_move_indexed(request, generation)
}

#[tauri::command]
pub fn index_move(
    from: String,
    to: String,
    generation: u64,
    to_address: MovedNoteAddress,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.index_move(from, to, generation, to_address)
}

#[tauri::command]
pub async fn index_reconcile_scan(
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<ReconcileScan> {
    core.index_reconcile_scan(generation).await
}

#[tauri::command]
pub fn index_touch(
    entries: Vec<IndexTouch>,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.index_touch(entries, generation)
}

#[tauri::command]
pub fn index_meta_set(
    key: String,
    value: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.index_meta_set(key, value, generation)
}

#[tauri::command]
pub fn index_clear(generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.index_clear(generation)
}

#[tauri::command]
pub fn chat_message_save(
    conversation: ChatConversation,
    message: ChatMessageRow,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.chat_message_save(conversation, message, generation)
}

#[tauri::command]
pub fn chat_conversation_delete(
    id: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.chat_conversation_delete(id, generation)
}

#[tauri::command]
pub fn embed_apply(
    path: String,
    chunks: Vec<EmbeddedChunk>,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.embed_apply(path, chunks, generation)
}

#[tauri::command]
pub fn embed_remove(path: String, generation: u64, core: State<Arc<Core>>) -> AppResult<()> {
    core.embed_remove(path, generation)
}

#[tauri::command]
pub async fn db_query(
    sql: String,
    params: Vec<Value>,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<Map<String, Value>>> {
    core.db_query(sql, params).await
}
