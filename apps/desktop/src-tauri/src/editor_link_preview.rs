//! Editor link-preview commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::editor_link_preview::LinkPreviewHtml;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub(crate) async fn link_preview_fetch_html(
    url: String,
    core: State<'_, Arc<Core>>,
) -> AppResult<LinkPreviewHtml> {
    core.link_preview_fetch_html(url).await
}

#[tauri::command]
pub(crate) async fn link_preview_fetch_icon(
    url: String,
    core: State<'_, Arc<Core>>,
) -> AppResult<String> {
    core.link_preview_fetch_icon(url).await
}
