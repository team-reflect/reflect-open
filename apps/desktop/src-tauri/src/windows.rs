//! Secondary note windows (modifier-click or command → its own window, Plan 06).
//!
//! The shell owns *creation* only: one preferred window per deep-link target,
//! plus the one-shot bootstrap a secondary webview calls to adopt the
//! already-open graph. A target normally receives a content-addressed label;
//! when that label belongs to the invoking window, a distinct suffixed label
//! becomes the new preferred destination. Adoption is strictly a read — the
//! note window must never re-run `graph_open`/`index_open`, whose generation
//! bumps would strand every command the main window has pinned to the current
//! sessions.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, MutexGuard, Once};

use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::db::{self, IndexState};
use crate::error::{AppError, AppResult};
use crate::fs::{self, GraphInfo, GraphState};
use crate::quit::QuitState;

/// App-wide note-window registry.
///
/// `preferred_destinations` separates a target's current destination from a
/// window's immutable Tauri label. That matters after a note window navigates:
/// modifier-opening its original target must create a distinct window rather
/// than reusing the invoking window. `pending_bootstraps` remains one-shot and
/// is drained by the destination's first `window_bootstrap` call. The separate
/// creation gate serializes Tauri's non-atomic window-label check and insert;
/// bootstrap deliberately never takes that gate.
#[derive(Default)]
pub struct WindowInit {
    registry: Mutex<WindowRegistry>,
    creation: Mutex<()>,
}

#[derive(Default)]
struct WindowRegistry {
    preferred_destinations: HashMap<String, String>,
    pending_bootstraps: HashMap<String, String>,
}

#[derive(Debug, Eq, PartialEq)]
enum WindowOpenPlan {
    Focus(String),
    Create(String),
}

/// The main window's label (Tauri's default for the config-declared window).
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Note-window labels carry this prefix; the capability files grant `note-*`
/// and the window-state plugin filters it out (geometry is cascaded fresh,
/// and hash labels would otherwise accrete in the state file forever).
pub const NOTE_WINDOW_PREFIX: &str = "note-";

/// Event delivered when an already-open target is requested again: the window
/// may have navigated elsewhere since it opened, so a focus alone could
/// surface the wrong note — the payload (the deep link) re-navigates it to the
/// requested target.
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

/// Resolve the OS-preferred theme background for `window`. Values mirror
/// `--surface-app` in `design-system/tokens/colors.css` (`:root` and `.dark`
/// scopes) so the native layer matches the first webview paint.
fn theme_background_color<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::webview::Color {
    use tauri::webview::Color;
    use tauri::Theme;

    match window.theme() {
        Ok(Theme::Dark) => Color(10, 15, 30, 255),
        _ => Color(248, 250, 250, 255),
    }
}

/// Paint the native window in the OS-preferred theme color before its first
/// reveal. Without this, the webview layer paints white for the frames between
/// `show()` and the frontend applying the design-system's `.dark` scope, so a
/// dark-mode user sees a white-to-dark flash. macOS's webview layer ignores
/// `set_background_color` — the paired theme script
/// (`apps/desktop/public/theme-init.js`, loaded from `index.html`) handles
/// that side.
#[cfg(desktop)]
fn apply_theme_background<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Err(err) = window.set_background_color(Some(theme_background_color(window))) {
        tracing::warn!(error = %err, label = window.label(), "failed to set window background color");
    }
}

#[cfg(desktop)]
fn surface_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    apply_theme_background(window);
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

fn lock_registry<'a>(
    state: &'a State<'_, WindowInit>,
) -> AppResult<MutexGuard<'a, WindowRegistry>> {
    state.registry.lock().map_err(|err| {
        tracing::error!(?err, "window registry lock poisoned by an earlier panic");
        AppError::io("window registry lock poisoned")
    })
}

fn lock_creation<'a>(state: &'a State<'_, WindowInit>) -> AppResult<MutexGuard<'a, ()>> {
    state.creation.lock().map_err(|err| {
        tracing::error!(?err, "window creation lock poisoned by an earlier panic");
        AppError::io("window creation lock poisoned")
    })
}

/// The label for a note window addressing `deep_link` — content-addressed so
/// reopening the same target focuses the existing window instead of piling up
/// duplicates. Stable within a process run, which is all dedupe needs.
fn note_window_label(deep_link: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    deep_link.hash(&mut hasher);
    format!("{NOTE_WINDOW_PREFIX}{:016x}", hasher.finish())
}

impl WindowRegistry {
    /// Select and reserve the destination for an open request.
    ///
    /// Repeated calls for the same not-yet-built target intentionally receive
    /// the same `Create` label. The outer creation gate serializes planning,
    /// focus, and native construction for that label. A request may never
    /// focus its invoking window, even when that window was the target's
    /// earlier preferred destination.
    fn plan_open(
        &mut self,
        deep_link: &str,
        invoking_label: &str,
        live_labels: &HashSet<String>,
    ) -> WindowOpenPlan {
        if let Some(preferred_label) = self.preferred_destinations.get(deep_link).cloned() {
            if preferred_label != invoking_label {
                if live_labels.contains(&preferred_label) {
                    return WindowOpenPlan::Focus(preferred_label);
                }
                self.pending_bootstraps
                    .insert(preferred_label.clone(), deep_link.to_owned());
                return WindowOpenPlan::Create(preferred_label);
            }
        }

        let base_label = note_window_label(deep_link);
        let label = (1_u64..)
            .map(|sequence| {
                if sequence == 1 {
                    base_label.clone()
                } else {
                    format!("{base_label}-{sequence}")
                }
            })
            .find(|candidate| {
                candidate != invoking_label
                    && !live_labels.contains(candidate)
                    && !self.pending_bootstraps.contains_key(candidate)
                    && !self
                        .preferred_destinations
                        .values()
                        .any(|preferred| preferred == candidate)
            })
            .expect("the unbounded note-window suffix space cannot be exhausted");

        self.preferred_destinations
            .insert(deep_link.to_owned(), label.clone());
        self.pending_bootstraps
            .insert(label.clone(), deep_link.to_owned());
        WindowOpenPlan::Create(label)
    }
}

/// Surface an already-open window for this target, when one exists: show,
/// focus, and deliver the link ([`WINDOW_NAVIGATE_EVENT`]) so a window that
/// has navigated away comes back to the note that was requested. All
/// best-effort — a focus that fails must not fail the open request.
fn focus_existing(
    app: &tauri::AppHandle,
    label: &str,
    deep_link: &str,
    invoking_label: &str,
) -> bool {
    if label == invoking_label {
        return false;
    }
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
    let issued_generation = fs::current_graph_info(&graph)?.generation;
    // Tauri's internal label availability check and window-map insertion are
    // separate operations. Serialize the whole plan/focus/build transaction,
    // not just our registry mutation, so two webviews cannot both pass the
    // native check for the same label. `window_bootstrap` uses only the
    // registry lock and can therefore run while this guard is held.
    let _creation_guard = lock_creation(&init)?;
    // Recheck mutable app state after waiting for an earlier creation. A queued
    // request must not build into a newer graph session or active quit
    // handshake than the click that issued it.
    // Mid-quit, a new webview would never join the handshake's pending set —
    // refuse and let modifier-click callers degrade to in-window navigation.
    if quit.armed() {
        return Err(AppError::io("the app is quitting"));
    }
    fs::root_for_generation(&graph, issued_generation)?;

    let invoking_label = window.label().to_owned();
    let label = loop {
        // Take the live-window snapshot while holding the registry lock. A
        // just-built window's bootstrap needs this same lock, so the snapshot
        // and reservation are ordered with its one-shot drain: we either see
        // the live destination and focus it, or reserve the still-pending
        // bootstrap that the new window will consume.
        let plan = {
            let mut registry = lock_registry(&init)?;
            let live_labels: HashSet<String> = app.webview_windows().into_keys().collect();
            registry.plan_open(&deep_link, &invoking_label, &live_labels)
        };
        match plan {
            WindowOpenPlan::Focus(preferred_label) => {
                if focus_existing(&app, &preferred_label, &deep_link, &invoking_label) {
                    return Ok(());
                }
                // The window closed after the locked snapshot. Re-plan from a
                // fresh snapshot; the missing preferred label becomes the
                // reserved-label build path below.
            }
            WindowOpenPlan::Create(reserved_label) => break reserved_label,
        }
    };
    let cascade = cascade_offset(&app);

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Reflect")
        .inner_size(1000.0, 650.0)
        // Paint the OS-preferred theme color at build time so the note window
        // doesn't briefly flash white before its webview loads the frontend
        // (mirrors the main window's `apply_theme_background`).
        .background_color(theme_background_color(&window))
        // Build hidden and reveal on `PageLoadEvent::Finished` so the user
        // never sees WKWebView's default white backing while HTML/CSS/JS are
        // still loading. The main window gets the same effect for free: its
        // `visible: false` config only flips to visible on `RunEvent::Ready`,
        // and Tauri's plugin + geometry-restore setup between builder and
        // Ready gives the webview time to reach the same state. `Once` gates
        // the reveal to the first Finished only: reloads (Cmd+R, dev HMR,
        // webview crash recovery) otherwise re-run `set_focus`, stealing
        // focus back to a note window the user has moved away from.
        .visible(false)
        .on_page_load({
            let revealed = Once::new();
            move |window, payload| {
                if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    return;
                }
                revealed.call_once(|| {
                    if let Err(err) = window.show() {
                        tracing::warn!(error = %err, label = window.label(), "failed to show note window after page load");
                    }
                    if let Err(err) = window.set_focus() {
                        tracing::warn!(error = %err, label = window.label(), "failed to focus note window after page load");
                    }
                });
            }
        })
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
        // Be defensive if a window created outside this command claimed the
        // reserved label: surface it and preserve its one-shot bootstrap.
        if focus_existing(&app, &label, &deep_link, &invoking_label) {
            return Ok(());
        }
        // Keep the pending bootstrap for a later serialized retry, which
        // reuses this preferred reservation.
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
    let initial_deep_link = lock_registry(&init)?
        .pending_bootstraps
        .remove(window.label());
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

    #[test]
    fn invoking_window_is_replaced_as_the_preferred_target_destination() {
        let deep_link = "reflect://note/notes/a.md";
        let mut registry = WindowRegistry::default();
        let mut live_labels = HashSet::from([MAIN_WINDOW_LABEL.to_owned()]);

        let WindowOpenPlan::Create(original_label) =
            registry.plan_open(deep_link, MAIN_WINDOW_LABEL, &live_labels)
        else {
            panic!("first open should create a note window");
        };
        registry.pending_bootstraps.remove(&original_label);
        live_labels.insert(original_label.clone());

        let WindowOpenPlan::Create(replacement_label) =
            registry.plan_open(deep_link, &original_label, &live_labels)
        else {
            panic!("opening from the preferred window should create a replacement");
        };
        assert_ne!(replacement_label, original_label);
        assert!(replacement_label.starts_with(&format!("{original_label}-")));

        registry.pending_bootstraps.remove(&replacement_label);
        live_labels.insert(replacement_label.clone());
        assert_eq!(
            registry.plan_open(deep_link, MAIN_WINDOW_LABEL, &live_labels),
            WindowOpenPlan::Focus(replacement_label)
        );
    }

    #[test]
    fn repeated_same_target_creations_share_the_reserved_label() {
        let deep_link = "reflect://note/notes/a.md";
        let mut registry = WindowRegistry::default();
        let live_labels = HashSet::from([MAIN_WINDOW_LABEL.to_owned()]);

        let first_plan = registry.plan_open(deep_link, MAIN_WINDOW_LABEL, &live_labels);
        let repeated_plan = registry.plan_open(deep_link, MAIN_WINDOW_LABEL, &live_labels);

        assert_eq!(repeated_plan, first_plan);
        assert!(matches!(first_plan, WindowOpenPlan::Create(_)));
    }

    #[test]
    fn bootstrap_registry_is_independent_from_creation_gate() {
        let init = WindowInit::default();
        let _creation_guard = init.creation.lock().expect("creation gate");
        let _registry_guard = init
            .registry
            .try_lock()
            .expect("bootstrap registry should remain available");
    }
}
