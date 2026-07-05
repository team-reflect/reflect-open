//! Secondary note windows (⌘-click a note link → its own window, Plan 06).
//!
//! The shell owns *creation* only: one window per deep-link target, deduped
//! by a content-addressed label, plus the one-shot bootstrap a secondary
//! webview calls to adopt the already-open graph. Adoption is strictly a
//! read — the note window must never re-run `graph_open`/`index_open`, whose
//! generation bumps would strand every command the main window has pinned to
//! the current sessions.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::db::{self, IndexState};
use crate::error::{AppError, AppResult};
use crate::fs::{self, GraphInfo, GraphState};

/// Deep links waiting for their window's first `window_bootstrap` call,
/// keyed by window label. Entries are one-shot: bootstrapping drains them.
#[derive(Default)]
pub struct WindowInit(Mutex<HashMap<String, String>>);

/// The main window's label (Tauri's default for the config-declared window).
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Note-window labels carry this prefix; the capability files grant `note-*`
/// and the window-state plugin filters it out (geometry is cascaded fresh,
/// and hash labels would otherwise accrete in the state file forever).
pub const NOTE_WINDOW_PREFIX: &str = "note-";

fn lock_init<'a>(
    state: &'a State<'_, WindowInit>,
) -> AppResult<MutexGuard<'a, HashMap<String, String>>> {
    state.0.lock().map_err(|err| {
        tracing::error!(?err, "window init lock poisoned by an earlier panic");
        AppError::io("window init lock poisoned")
    })
}

/// The label for a note window addressing `deep_link` — content-addressed so
/// ⌘-clicking the same target focuses the existing window instead of piling
/// up duplicates. Stable within a process run, which is all dedupe needs.
fn note_window_label(deep_link: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    deep_link.hash(&mut hasher);
    format!("{NOTE_WINDOW_PREFIX}{:016x}", hasher.finish())
}

/// Open (or focus) a secondary window on a `reflect://` route link.
///
/// Requires an open graph: a note window can only *adopt* the main window's
/// session, so with nothing open there is nothing to show. Async on purpose —
/// window creation from a sync command can deadlock the main thread on some
/// platforms (Tauri's own guidance).
#[tauri::command]
pub async fn open_note_window(
    deep_link: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    graph: State<'_, GraphState>,
    init: State<'_, WindowInit>,
) -> AppResult<()> {
    if !deep_link.starts_with("reflect://") {
        return Err(AppError::parse(format!(
            "not a reflect:// link: {deep_link}"
        )));
    }
    fs::current_graph_info(&graph)?;

    let label = note_window_label(&deep_link);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    lock_init(&init)?.insert(label.clone(), deep_link);

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Reflect")
        .inner_size(1000.0, 650.0)
        // Match the main window: HTML5 drops must reach the webview (chat and
        // editor file drops), so the native drag-drop handler stays off.
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    // Cascade from the invoking window so stacked opens don't cover each
    // other exactly. Best-effort: a position we can't read just means the OS
    // default placement.
    if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor()) {
        let position = position.to_logical::<f64>(scale);
        builder = builder.position(position.x + 48.0, position.y + 48.0);
    }

    if let Err(err) = builder.build() {
        // The window never booted, so its pending deep link must not linger
        // (a later same-target open would inherit a stale entry harmlessly,
        // but hygiene is cheap).
        lock_init(&init)?.remove(&label);
        return Err(AppError::io(format!("failed to open note window: {err}")));
    }
    Ok(())
}

/// What a secondary window needs to boot: the open graph's identity (both
/// session generations, unbumped) and the deep link it was created to show.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBootstrap {
    pub graph: GraphInfo,
    /// The open index session's generation, or null when the main window's
    /// index failed to open (the note window then boots without index reads).
    pub index_generation: Option<u64>,
    /// The `reflect://` link this window was opened for — one-shot, absent on
    /// a reload (the router simply stays where the reloaded window was).
    pub initial_deep_link: Option<String>,
}

/// Adopt the open graph for a secondary window: a pure read of the current
/// graph + index sessions plus the one-shot initial deep link stored by
/// [`open_note_window`]. Errors when no graph is open — only reachable by
/// racing a graph switch, and the window shows an error rather than a
/// chooser (choosing from a note window would re-root every other window).
#[tauri::command]
pub fn window_bootstrap(
    window: tauri::WebviewWindow,
    graph: State<GraphState>,
    index: State<IndexState>,
    init: State<WindowInit>,
) -> AppResult<WindowBootstrap> {
    let graph = fs::current_graph_info(&graph)?;
    let index_generation = db::current_generation(&index)?;
    let initial_deep_link = lock_init(&init)?.remove(window.label());
    Ok(WindowBootstrap {
        graph,
        index_generation,
        initial_deep_link,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_stable_per_target_and_distinct_across_targets() {
        let a1 = note_window_label("reflect://note/notes/a.md");
        let a2 = note_window_label("reflect://note/notes/a.md");
        let b = note_window_label("reflect://note/notes/b.md");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert!(a1.starts_with(NOTE_WINDOW_PREFIX));
    }
}
