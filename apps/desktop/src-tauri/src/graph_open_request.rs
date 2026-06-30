//! App-open requests for graph folders.
//!
//! On macOS, dragging an item onto the Dock icon arrives as a Tauri
//! `RunEvent::Opened`. The frontend owns the graph-open lifecycle, so Rust only
//! validates the native payload, queues exactly one directory per open event,
//! and nudges the webview to drain the queue.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State, Url};

/// Event emitted when at least one graph-open request is waiting in Rust.
pub const GRAPH_OPEN_REQUESTED_EVENT: &str = "graph:open-requested";

/// Pending graph-open requests not yet consumed by the frontend.
#[derive(Default)]
pub struct GraphOpenRequestState(Mutex<VecDeque<String>>);

/// Queue a graph-open request from native "open document" URLs.
///
/// Exactly one item must be present and it must be a folder. Multi-item drops
/// and files are ignored so a Dock drop cannot ambiguously switch graphs.
pub fn queue_opened_urls(app: &AppHandle, state: &State<GraphOpenRequestState>, urls: &[Url]) {
    match folder_path_from_urls(urls) {
        Ok(Some(path)) => {
            match state.0.lock() {
                Ok(mut pending) => {
                    pending.push_back(path.to_string_lossy().into_owned());
                }
                Err(err) => {
                    tracing::error!(?err, "graph open request queue lock poisoned");
                    return;
                }
            };
            let _ = app.emit(GRAPH_OPEN_REQUESTED_EVENT, ());
        }
        Ok(None) => {}
        Err(message) => tracing::warn!(%message, "ignored graph open request"),
    }
}

fn folder_path_from_urls(urls: &[Url]) -> Result<Option<PathBuf>, String> {
    if urls.is_empty() {
        return Ok(None);
    }
    if urls.len() != 1 {
        return Err(format!(
            "expected exactly one folder, received {} items",
            urls.len()
        ));
    }

    let url = &urls[0];
    if url.scheme() != "file" {
        return Err(format!("expected a file URL, received {}", url.scheme()));
    }

    let path = url
        .to_file_path()
        .map_err(|_| "could not convert file URL to a path".to_string())?;
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    Ok(Some(path))
}

/// Pop the oldest queued graph-open request.
#[tauri::command]
pub fn graph_open_request_take(state: State<GraphOpenRequestState>) -> Option<String> {
    match state.0.lock() {
        Ok(mut pending) => pending.pop_front(),
        Err(err) => {
            tracing::error!(?err, "graph open request queue lock poisoned");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::folder_path_from_urls;
    use tauri::Url;
    use tempfile::tempdir;

    #[test]
    fn accepts_exactly_one_directory() {
        let dir = tempdir().expect("tempdir");
        let url = Url::from_directory_path(dir.path()).expect("directory url");

        let path = folder_path_from_urls(&[url])
            .expect("valid request")
            .expect("path");

        assert_eq!(path, dir.path());
    }

    #[test]
    fn rejects_multiple_items() {
        let first = tempdir().expect("first tempdir");
        let second = tempdir().expect("second tempdir");
        let urls = [
            Url::from_directory_path(first.path()).expect("first url"),
            Url::from_directory_path(second.path()).expect("second url"),
        ];

        let error = folder_path_from_urls(&urls).expect_err("multiple items should fail");

        assert!(error.contains("expected exactly one folder"));
    }

    #[test]
    fn rejects_files() {
        let dir = tempdir().expect("tempdir");
        let file = dir.path().join("note.md");
        std::fs::write(&file, "").expect("write file");
        let url = Url::from_file_path(&file).expect("file url");

        let error = folder_path_from_urls(&[url]).expect_err("file should fail");

        assert!(error.contains("not a directory"));
    }
}
