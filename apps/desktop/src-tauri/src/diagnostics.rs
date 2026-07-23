//! Privacy-safe lifecycle diagnostics for otherwise opaque iOS terminations.
//!
//! This is deliberately not a general log sink. The persisted schema accepts
//! only closed event enums and sanitized build metadata, so note content,
//! paths, URLs, settings, and arbitrary error messages cannot enter the
//! journal. The bounded snapshot is useful when WebKit or iOS kills a process
//! without producing a conventional crash stack.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(any(target_os = "ios", test))]
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
#[cfg(target_os = "ios")]
use tauri::Manager;
use tauri::{AppHandle, Runtime, State};
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

const SCHEMA_VERSION: u8 = 1;
const MAX_EVENTS: usize = 128;
const TERMINATION_WINDOW_MS: u64 = 5 * 60 * 1_000;
#[cfg(any(target_os = "ios", test))]
const SAFE_MODE_TERMINATION_COUNT: usize = 3;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticCheckpoint {
    PlatformResolved,
    MobileRootMounted,
    GraphLoading,
    GraphOpening,
    GraphReady,
    GraphUnavailable,
    IndexReconcileStarted,
    IndexLive,
    Backgrounded,
    Foregrounded,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum DiagnosticWindow {
    Main,
    Note,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SafeModeReason {
    RepeatedWebContentTerminations,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum DiagnosticEvent {
    AppStarted {
        at_ms: u64,
    },
    Checkpoint {
        at_ms: u64,
        checkpoint: DiagnosticCheckpoint,
    },
    FrontendReady {
        at_ms: u64,
    },
    WebContentTerminated {
        at_ms: u64,
        uptime_ms: u64,
        window: DiagnosticWindow,
        recent_count: u8,
    },
    WebContentReloaded {
        at_ms: u64,
        success: bool,
    },
    SafeModeEntered {
        at_ms: u64,
        reason: SafeModeReason,
    },
    SafeModeCleared {
        at_ms: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticStore {
    schema_version: u8,
    safe_mode_reason: Option<SafeModeReason>,
    termination_timestamps_ms: Vec<u64>,
    events: Vec<DiagnosticEvent>,
}

impl Default for DiagnosticStore {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            safe_mode_reason: None,
            termination_timestamps_ms: Vec::new(),
            events: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsStatus {
    safe_mode: bool,
    reason: Option<SafeModeReason>,
    recent_web_content_terminations: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    schema_version: u8,
    generated_at_ms: u64,
    app_version: String,
    build: Option<String>,
    safe_mode: bool,
    reason: Option<SafeModeReason>,
    recent_web_content_terminations: u8,
    events: Vec<DiagnosticEvent>,
}

pub struct DiagnosticsState {
    path: Option<PathBuf>,
    #[cfg(any(target_os = "ios", test))]
    started_at: Instant,
    store: Mutex<DiagnosticStore>,
}

impl Default for DiagnosticsState {
    fn default() -> Self {
        let path = store_path();
        let store = path
            .as_deref()
            .and_then(|path| match load_from(path) {
                Ok(store) => Some(store),
                Err(_) => {
                    tracing::warn!("ignoring unreadable diagnostics journal");
                    None
                }
            })
            .unwrap_or_default();
        Self {
            path,
            #[cfg(any(target_os = "ios", test))]
            started_at: Instant::now(),
            store: Mutex::new(store),
        }
    }
}

impl DiagnosticsState {
    fn bootstrap(&self, now_ms: u64) -> DiagnosticsStatus {
        let mut store = self.lock_store();
        prune_terminations(&mut store, now_ms);
        push_event(&mut store, DiagnosticEvent::AppStarted { at_ms: now_ms });
        self.persist_best_effort(&store);
        status_from(&store)
    }

    fn checkpoint(&self, checkpoint: DiagnosticCheckpoint, now_ms: u64) {
        let mut store = self.lock_store();
        if matches!(
            store.events.last(),
            Some(DiagnosticEvent::Checkpoint {
                checkpoint: previous,
                ..
            }) if *previous == checkpoint
        ) {
            return;
        }
        push_event(
            &mut store,
            DiagnosticEvent::Checkpoint {
                at_ms: now_ms,
                checkpoint,
            },
        );
        self.persist_best_effort(&store);
    }

    fn frontend_ready(&self, now_ms: u64) {
        let mut store = self.lock_store();
        if matches!(
            store.events.last(),
            Some(DiagnosticEvent::FrontendReady { .. })
        ) {
            return;
        }
        push_event(&mut store, DiagnosticEvent::FrontendReady { at_ms: now_ms });
        self.persist_best_effort(&store);
    }

    #[cfg(any(target_os = "ios", test))]
    fn web_content_terminated(&self, label: &str, now_ms: u64) -> bool {
        let window = classify_window(label);
        let mut store = self.lock_store();
        prune_terminations(&mut store, now_ms);
        let recovery_was_already_active =
            window == DiagnosticWindow::Main && store.safe_mode_reason.is_some();

        let recent_count = if window == DiagnosticWindow::Main {
            store.termination_timestamps_ms.push(now_ms);
            store.termination_timestamps_ms.len()
        } else {
            0
        };
        push_event(
            &mut store,
            DiagnosticEvent::WebContentTerminated {
                at_ms: now_ms,
                uptime_ms: u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
                window,
                recent_count: u8::try_from(recent_count).unwrap_or(u8::MAX),
            },
        );

        if recent_count >= SAFE_MODE_TERMINATION_COUNT && store.safe_mode_reason.is_none() {
            let reason = SafeModeReason::RepeatedWebContentTerminations;
            store.safe_mode_reason = Some(reason);
            push_event(
                &mut store,
                DiagnosticEvent::SafeModeEntered {
                    at_ms: now_ms,
                    reason,
                },
            );
        }
        self.persist_best_effort(&store);
        !recovery_was_already_active
    }

    #[cfg(target_os = "ios")]
    fn web_content_reloaded(&self, success: bool, now_ms: u64) {
        let mut store = self.lock_store();
        push_event(
            &mut store,
            DiagnosticEvent::WebContentReloaded {
                at_ms: now_ms,
                success,
            },
        );
        self.persist_best_effort(&store);
    }

    fn retry_normal(&self, now_ms: u64) {
        let mut store = self.lock_store();
        store.safe_mode_reason = None;
        store.termination_timestamps_ms.clear();
        push_event(
            &mut store,
            DiagnosticEvent::SafeModeCleared { at_ms: now_ms },
        );
        self.persist_best_effort(&store);
    }

    fn snapshot(&self, app_version: &str, build: Option<&str>, now_ms: u64) -> DiagnosticsSnapshot {
        let mut store = self.lock_store();
        prune_terminations(&mut store, now_ms);
        let status = status_from(&store);
        DiagnosticsSnapshot {
            schema_version: SCHEMA_VERSION,
            generated_at_ms: now_ms,
            app_version: sanitize_version(app_version),
            build: build.and_then(sanitize_build),
            safe_mode: status.safe_mode,
            reason: status.reason,
            recent_web_content_terminations: status.recent_web_content_terminations,
            events: store.events.clone(),
        }
    }

    fn lock_store(&self) -> std::sync::MutexGuard<'_, DiagnosticStore> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist_best_effort(&self, store: &DiagnosticStore) {
        let Some(path) = self.path.as_deref() else {
            return;
        };
        if save_to(path, store).is_err() {
            tracing::warn!("failed to persist diagnostics journal");
        }
    }

    #[cfg(test)]
    fn from_path(path: PathBuf) -> Self {
        let store = load_from(&path).unwrap_or_default();
        Self {
            path: Some(path),
            started_at: Instant::now(),
            store: Mutex::new(store),
        }
    }
}

fn store_path() -> Option<PathBuf> {
    dirs::config_dir().map(|base| {
        base.join("reflect-open")
            .join("diagnostics")
            .join("events.json")
    })
}

fn load_from(path: &Path) -> AppResult<DiagnosticStore> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiagnosticStore::default());
        }
        Err(err) => return Err(err.into()),
    };
    let store: DiagnosticStore =
        serde_json::from_str(&raw).map_err(|err| AppError::io(err.to_string()))?;
    if store.schema_version != SCHEMA_VERSION {
        return Err(AppError::io("unsupported diagnostics journal version"));
    }
    if !is_safe_store(&store) {
        return Err(AppError::io("unsafe diagnostics journal contents"));
    }
    Ok(store)
}

fn is_safe_store(store: &DiagnosticStore) -> bool {
    store.events.len() <= MAX_EVENTS && store.termination_timestamps_ms.len() <= MAX_EVENTS
}

fn save_to(path: &Path, store: &DiagnosticStore) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::io("diagnostics store path has no parent directory"))?;
    let created = !dir.exists();
    fs::create_dir_all(dir)?;
    if created {
        crate::fs::mark_dir_local_only(dir);
    }
    let json = serde_json::to_vec(store).map_err(|err| AppError::io(err.to_string()))?;
    let mut tmp = NamedTempFile::new_in(dir)?;
    tmp.write_all(&json)?;
    tmp.flush()?;
    tmp.persist(path)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

fn push_event(store: &mut DiagnosticStore, event: DiagnosticEvent) {
    store.events.push(event);
    let excess = store.events.len().saturating_sub(MAX_EVENTS);
    if excess > 0 {
        store.events.drain(..excess);
    }
}

fn prune_terminations(store: &mut DiagnosticStore, now_ms: u64) {
    store.termination_timestamps_ms.retain(|timestamp| {
        *timestamp <= now_ms && now_ms.saturating_sub(*timestamp) <= TERMINATION_WINDOW_MS
    });
}

fn status_from(store: &DiagnosticStore) -> DiagnosticsStatus {
    DiagnosticsStatus {
        safe_mode: store.safe_mode_reason.is_some(),
        reason: store.safe_mode_reason,
        recent_web_content_terminations: u8::try_from(store.termination_timestamps_ms.len())
            .unwrap_or(u8::MAX),
    }
}

#[cfg(any(target_os = "ios", test))]
fn classify_window(label: &str) -> DiagnosticWindow {
    if label == crate::windows::MAIN_WINDOW_LABEL {
        DiagnosticWindow::Main
    } else if label.starts_with(crate::windows::NOTE_WINDOW_PREFIX) {
        DiagnosticWindow::Note
    } else {
        DiagnosticWindow::Other
    }
}

fn sanitize_version(value: &str) -> String {
    let value = value.trim();
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let mut core_parts = value[..core_end].split('.');
    let valid_core = (0..3).all(|_| {
        core_parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    }) && core_parts.next().is_none();
    let valid_suffix = core_end == value.len() || core_end + 1 < value.len();
    if value.len() <= 64
        && valid_core
        && valid_suffix
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        value.to_string()
    } else {
        "unknown".to_string()
    }
}

fn sanitize_build(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 32 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(target_os = "ios")]
fn app_build_number() -> Option<String> {
    use objc2_foundation::{ns_string, NSBundle, NSString};

    let value = NSBundle::mainBundle().objectForInfoDictionaryKey(ns_string!("CFBundleVersion"))?;
    let build = value.downcast::<NSString>().ok()?.to_string();
    sanitize_build(&build)
}

#[cfg(not(target_os = "ios"))]
fn app_build_number() -> Option<String> {
    None
}

#[tauri::command]
pub fn diagnostics_bootstrap(state: State<'_, DiagnosticsState>) -> DiagnosticsStatus {
    state.bootstrap(now_ms())
}

#[tauri::command]
pub fn diagnostics_checkpoint(
    checkpoint: DiagnosticCheckpoint,
    state: State<'_, DiagnosticsState>,
) {
    state.checkpoint(checkpoint, now_ms());
}

#[tauri::command]
pub fn diagnostics_frontend_ready(state: State<'_, DiagnosticsState>) {
    state.frontend_ready(now_ms());
}

#[tauri::command]
pub fn diagnostics_retry_normal(state: State<'_, DiagnosticsState>) {
    state.retry_normal(now_ms());
}

#[tauri::command]
pub fn diagnostics_snapshot<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiagnosticsState>,
) -> DiagnosticsSnapshot {
    let build = app_build_number();
    state.snapshot(
        &app.package_info().version.to_string(),
        build.as_deref(),
        now_ms(),
    )
}

#[cfg(target_os = "ios")]
pub fn record_web_content_termination<R: Runtime>(webview: &tauri::Webview<R>) {
    let state = webview.app_handle().state::<DiagnosticsState>();
    let should_reload = state.web_content_terminated(webview.label(), now_ms());
    if !should_reload {
        return;
    }
    let reload = webview.reload();
    state.web_content_reloaded(reload.is_ok(), now_ms());
    if let Err(err) = reload {
        tracing::warn!(error = %err, "reloading terminated web content process failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn state() -> (tempfile::TempDir, DiagnosticsState) {
        let dir = tempdir().unwrap();
        let state = DiagnosticsState::from_path(dir.path().join("diagnostics").join("events.json"));
        (dir, state)
    }

    #[test]
    fn third_recent_main_termination_enters_safe_mode_and_requests_recovery_reload() {
        let (_dir, state) = state();
        assert!(state.web_content_terminated("main", 1_000));
        assert!(state.web_content_terminated("main", 2_000));
        assert!(state.web_content_terminated("main", 3_000));

        let snapshot = state.snapshot("1.2.3", Some("42"), 3_000);
        assert!(snapshot.safe_mode);
        assert_eq!(
            snapshot.reason,
            Some(SafeModeReason::RepeatedWebContentTerminations)
        );
        assert_eq!(snapshot.recent_web_content_terminations, 3);
        assert!(snapshot
            .events
            .iter()
            .any(|event| matches!(event, DiagnosticEvent::SafeModeEntered { .. })));
    }

    #[test]
    fn main_termination_does_not_reload_when_recovery_is_already_active() {
        let (_dir, state) = state();
        for now in [1_000, 2_000, 3_000] {
            assert!(state.web_content_terminated("main", now));
        }

        assert!(!state.web_content_terminated("main", 4_000));
        assert!(state.web_content_terminated("note-secondary", 5_000));
    }

    #[test]
    fn old_and_secondary_window_terminations_do_not_enter_safe_mode() {
        let (_dir, state) = state();
        state.web_content_terminated("main", 1_000);
        state.web_content_terminated("main", 2_000);
        state.web_content_terminated("note-private-label", TERMINATION_WINDOW_MS + 2_001);
        state.web_content_terminated("main", TERMINATION_WINDOW_MS + 2_002);

        let snapshot = state.snapshot("1.2.3", None, TERMINATION_WINDOW_MS + 2_002);
        assert!(!snapshot.safe_mode);
        assert_eq!(snapshot.recent_web_content_terminations, 1);
    }

    #[test]
    fn explicit_retry_clears_safe_mode_and_burst() {
        let (_dir, state) = state();
        for now in [1_000, 2_000, 3_000] {
            state.web_content_terminated("main", now);
        }
        state.retry_normal(4_000);

        let snapshot = state.snapshot("1.2.3", None, 4_000);
        assert!(!snapshot.safe_mode);
        assert_eq!(snapshot.recent_web_content_terminations, 0);
        assert!(matches!(
            snapshot.events.last(),
            Some(DiagnosticEvent::SafeModeCleared { .. })
        ));
    }

    #[test]
    fn store_round_trips_and_caps_events() {
        let (dir, state) = state();
        for index in 0..(MAX_EVENTS + 20) {
            state.checkpoint(DiagnosticCheckpoint::GraphLoading, index as u64);
            state.checkpoint(DiagnosticCheckpoint::GraphOpening, index as u64);
        }
        drop(state);

        let reloaded =
            DiagnosticsState::from_path(dir.path().join("diagnostics").join("events.json"));
        let snapshot = reloaded.snapshot("1.2.3", Some("42"), 10_000);
        assert_eq!(snapshot.events.len(), MAX_EVENTS);
    }

    #[test]
    fn corrupt_store_fails_open() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("events.json");
        fs::write(&path, "{ private note").unwrap();

        let state = DiagnosticsState::from_path(path);
        let status = state.bootstrap(1_000);
        assert!(!status.safe_mode);
        assert_eq!(status.recent_web_content_terminations, 0);
    }

    #[test]
    fn unsafe_persisted_metadata_fails_open() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("events.json");
        fs::write(
            &path,
            r#"{
                "schemaVersion": 1,
                "safeModeReason": "repeatedWebContentTerminations",
                "terminationTimestampsMs": [900],
                "events": [{
                    "kind": "appStarted",
                    "atMs": 900,
                    "appVersion": "../private-note",
                    "build": "42-person@example.com"
                }]
            }"#,
        )
        .unwrap();

        let state = DiagnosticsState::from_path(path);
        let status = state.bootstrap(1_000);
        let snapshot = state.snapshot("1.2.3", Some("42"), 1_000);
        let json = serde_json::to_string(&snapshot).unwrap();

        assert!(!status.safe_mode);
        assert!(!json.contains("private-note"));
        assert!(!json.contains("person@example.com"));
    }

    #[test]
    fn serialization_cannot_admit_labels_or_unsafe_build_metadata() {
        let (_dir, state) = state();
        state.bootstrap(1_000);
        state.web_content_terminated("person@example.com/private-note", 2_000);
        let snapshot = state.snapshot("1.2.3/private-note", Some("42-person@example.com"), 2_000);
        let json = serde_json::to_string(&snapshot).unwrap();

        assert!(!json.contains("private-note"));
        assert!(!json.contains("person@example.com"));
        assert!(json.contains("\"window\":\"other\""));
        assert!(json.contains("\"appVersion\":\"unknown\""));
        assert!(json.contains("\"build\":null"));
    }
}
