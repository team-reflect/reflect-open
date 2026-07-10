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
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::db::{self, IndexState};
use crate::error::{AppError, AppResult};
use crate::fs::{self, GraphInfo, GraphState};
use crate::quit::QuitState;

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

/// Event delivered to an existing note window when its target is ⌘-clicked
/// again: the window may have navigated elsewhere since it opened, so a
/// focus alone could surface the wrong note — the payload (the deep link)
/// re-navigates it to the clicked target.
const WINDOW_NAVIGATE_EVENT: &str = "window:navigate";

/// Window properties that survive a desktop restart.
///
/// Visibility is intentionally absent. The main window starts hidden while
/// geometry restores, and shutdown or updater relaunches can otherwise persist
/// that temporary state and leave every subsequent launch hidden.
#[cfg(desktop)]
pub(crate) fn restorable_window_state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;

    StateFlags::SIZE
        | StateFlags::POSITION
        | StateFlags::MAXIMIZED
        | StateFlags::DECORATIONS
        | StateFlags::FULLSCREEN
}

#[cfg(desktop)]
fn surface_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Err(err) = window.unminimize() {
        tracing::warn!(error = %err, label = window.label(), "failed to unminimize window");
    }
    if let Err(err) = window.show() {
        tracing::warn!(error = %err, label = window.label(), "failed to show window");
    }
    if let Err(err) = window.set_focus() {
        tracing::warn!(error = %err, label = window.label(), "failed to focus window");
    }
}

/// Show, unminimize, and focus the existing main window.
///
/// Returns whether the window exists, so macOS Dock reopen handling can create
/// a replacement after the user has closed the original window.
#[cfg(desktop)]
pub(crate) fn surface_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return false;
    };
    surface_window(&window);
    true
}

/// Recover the main window when macOS asks an app with no visible windows to
/// reopen (normally a Dock click).
#[cfg(target_os = "macos")]
pub(crate) fn reopen_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if app.state::<QuitState>().armed() {
        return;
    }
    if surface_main_window(app) {
        return;
    }

    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == MAIN_WINDOW_LABEL)
        .cloned()
    else {
        tracing::warn!("cannot reopen main window because its config is missing");
        return;
    };

    match WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build()) {
        Ok(window) => surface_window(&window),
        Err(err) => tracing::warn!(error = %err, "failed to recreate main window"),
    }
}

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

/// Surface an already-open window for this target, when one exists: show,
/// focus, and deliver the link ([`WINDOW_NAVIGATE_EVENT`]) so a window that
/// has navigated away comes back to the note that was clicked. All
/// best-effort — a focus that fails must not fail the click.
fn focus_existing(app: &tauri::AppHandle, label: &str, deep_link: &str) -> bool {
    let Some(existing) = app.get_webview_window(label) else {
        return false;
    };
    let _ = existing.show();
    let _ = existing.set_focus();
    let _ = app.emit_to(label, WINDOW_NAVIGATE_EVENT, deep_link);
    true
}

/// Cascade step for the next note window: successive opens from one window
/// must not stack at a single offset, covering each other exactly. Steps by
/// the number of live note windows and wraps so a pile never marches
/// off-screen.
fn cascade_offset(app: &tauri::AppHandle) -> f64 {
    let open_note_windows = app
        .webview_windows()
        .keys()
        .filter(|existing| existing.starts_with(NOTE_WINDOW_PREFIX))
        .count();
    48.0 * ((open_note_windows % 10) + 1) as f64
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
    quit: State<'_, QuitState>,
) -> AppResult<()> {
    if !deep_link.starts_with("reflect://") {
        return Err(AppError::parse(format!(
            "not a reflect:// link: {deep_link}"
        )));
    }
    // Mid-quit, a new webview would never join the flush handshake's pending
    // set — the armed windows' confirms would exit underneath it. Refuse
    // (best-effort: the ⌘-click site degrades to in-window navigation).
    if quit.armed() {
        return Err(AppError::io("the app is quitting"));
    }
    fs::current_graph_info(&graph)?;

    let label = note_window_label(&deep_link);
    if focus_existing(&app, &label, &deep_link) {
        return Ok(());
    }
    let cascade = cascade_offset(&app);

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
    // Cascade from the invoking window. Best-effort: a position we can't
    // read just means the OS default placement.
    if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor()) {
        let position = position.to_logical::<f64>(scale);
        builder = builder.position(position.x + cascade, position.y + cascade);
    }

    if let Err(err) = builder.build() {
        // Clean the pending link up ONLY when no window claimed the label: a
        // concurrent same-target open can fail exactly because the first
        // call's window already exists, and that window's bootstrap still
        // needs the entry (both calls stored the identical link).
        if app.get_webview_window(&label).is_none() {
            lock_init(&init)?.remove(&label);
        }
        return Err(AppError::io(format!("failed to open note window: {err}")));
    }
    Ok(())
}

/// Close every note window and wait (bounded) for them to be gone.
///
/// The graph provider calls this **before** any generation bump (graph
/// switch or delete): note windows adopted the session being replaced, and
/// each `close()` runs the child's close-requested flush against the
/// still-valid generation — bumping first would reject their last saves as
/// stale. A destroyed webview implies its flush completed (close-requested
/// defers destruction until the handler resolves), so "all gone" is the
/// safe-to-bump signal. Best-effort past the deadline: a wedged child must
/// not block the switch forever — it dies with the old session either way.
#[tauri::command]
pub async fn close_note_windows(app: tauri::AppHandle) -> AppResult<()> {
    let note_windows = |app: &tauri::AppHandle| -> Vec<tauri::WebviewWindow> {
        app.webview_windows()
            .into_iter()
            .filter(|(label, _)| label.starts_with(NOTE_WINDOW_PREFIX))
            .map(|(_, window)| window)
            .collect()
    };
    let open = note_windows(&app);
    if open.is_empty() {
        return Ok(());
    }
    for window in open {
        let _ = window.close();
    }
    for _ in 0..40 {
        if note_windows(&app).is_empty() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    tracing::warn!("note windows still open after the close deadline; proceeding");
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

    #[cfg(desktop)]
    #[test]
    fn restart_state_restores_geometry_but_never_visibility() {
        use tauri_plugin_window_state::StateFlags;

        let flags = restorable_window_state_flags();
        for geometry_flag in [
            StateFlags::SIZE,
            StateFlags::POSITION,
            StateFlags::MAXIMIZED,
            StateFlags::DECORATIONS,
            StateFlags::FULLSCREEN,
        ] {
            assert!(flags.contains(geometry_flag));
        }
        assert!(!flags.contains(StateFlags::VISIBLE));
    }

    #[cfg(desktop)]
    #[test]
    fn surfacing_main_window_distinguishes_missing_and_existing_windows() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        assert!(!surface_main_window(app.handle()));

        let _main = WebviewWindowBuilder::new(&app, MAIN_WINDOW_LABEL, WebviewUrl::default())
            .visible(false)
            .build()
            .expect("main window");
        assert!(surface_main_window(app.handle()));
    }

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
