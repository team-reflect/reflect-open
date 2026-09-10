//! TEMPORARY window-geometry probe for the macOS 26 "2x2 main window" bug.
//! This module ships only in the `probe-window-state-macos26` branch and is
//! never merged: it exists to collect, on a macOS 26 machine, every piece of
//! data needed to decide whether the frame collapse is produced by AppKit
//! (window/view frame really goes to ~1pt) or by the tao/tauri layer (AppKit
//! reports a sane frame while tao reports a tiny one).
//!
//! What it records, all into `<app-config-dir>/window-probe/`:
//!
//! - `probe.log`: one JSON object per line. Boot info (OS build, AppKit
//!   version, monitors, raw state file), every window event (`Resized`,
//!   `Moved`, close/destroy/focus/scale), a 250ms sampler that logs on any
//!   geometry change, run-loop events (`Ready`, `ExitRequested`, `Exit`),
//!   and a full dump at exit. Every geometry record carries both the
//!   tao-level view (`inner_size`, `outer_position`, ...) and the raw
//!   AppKit view (NSWindow frame, contentView frame, contentRect, styleMask,
//!   isZoomed, occlusion, screen frames), captured on the main thread.
//! - `state-history/<ms>.json`: a copy of `.window-state.json` every time
//!   its content changes.
//!
//! A scenario runner replays the exit/restore cycles that surround the bug
//! (updater-style relaunches via `request_restart`, zoom, un-zoom races,
//! hide, minimize, fullscreen, and externally-driven tiling phases). It is
//! driven by `window-probe/plan.txt` (one scenario per line, `#` comments);
//! without a plan the app just logs while being used by hand. See
//! `apps/desktop/scripts/window-probe/README.md`.

use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};

const MAIN_WINDOW: &str = "main";
/// Hard cap on chained relaunches, so a bad plan can never leave the tester
/// with an app that restarts itself forever.
const MAX_LAUNCHES: u64 = 200;
/// Physical pixels; any observed dimension below this triggers a full dump
/// tagged "anomaly".
const ANOMALY_PX: u32 = 300;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn probe_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("window-probe");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn state_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(
        app.path()
            .app_config_dir()
            .ok()?
            .join(tauri_plugin_window_state::DEFAULT_FILENAME),
    )
}

pub fn log_record<R: Runtime>(app: &AppHandle<R>, tag: &str, mut record: Value) {
    let Some(dir) = probe_dir(app) else { return };
    if let Some(map) = record.as_object_mut() {
        map.insert("t".into(), json!(now_ms() as u64));
        map.insert("pid".into(), json!(std::process::id()));
        map.insert("tag".into(), json!(tag));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("probe.log"))
    {
        let _ = writeln!(f, "{record}");
    }
}

/// The tao/tauri view of the main window's geometry. Callable from any
/// thread (the getters proxy to the event loop).
fn tao_snapshot<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Value {
    json!({
        "innerSize": window.inner_size().map(|s| [s.width, s.height]).ok(),
        "outerSize": window.outer_size().map(|s| [s.width, s.height]).ok(),
        "outerPosition": window.outer_position().map(|p| [p.x, p.y]).ok(),
        "scaleFactor": window.scale_factor().ok(),
        "maximized": window.is_maximized().ok(),
        "minimized": window.is_minimized().ok(),
        "fullscreen": window.is_fullscreen().ok(),
        "visible": window.is_visible().ok(),
        "focused": window.is_focused().ok(),
    })
}

#[cfg(target_os = "macos")]
mod appkit {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use serde_json::{json, Value};
    use tauri::Runtime;

    fn rect(r: NSRect) -> Value {
        json!([r.origin.x, r.origin.y, r.size.width, r.size.height])
    }

    fn size(s: NSSize) -> Value {
        json!([s.width, s.height])
    }

    fn point(p: NSPoint) -> Value {
        json!([p.x, p.y])
    }

    /// The raw AppKit view of the same window. MUST run on the main thread;
    /// callers go through `run_on_main_thread` or an event-loop callback.
    pub fn snapshot<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Value {
        let Ok(ptr) = window.ns_window() else {
            return json!({ "error": "no ns_window" });
        };
        let ns: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
        let frame = ns.frame();
        let content_rect = ns.contentRectForFrameRect(frame);
        let content_view = ns.contentView().map(|view| rect(view.frame()));
        let screen = ns.screen().map(|screen| {
            json!({
                "frame": rect(screen.frame()),
                "visibleFrame": rect(screen.visibleFrame()),
                "backingScaleFactor": screen.backingScaleFactor(),
            })
        });
        json!({
            "frame": rect(frame),
            "frameOrigin": point(frame.origin),
            "contentRect": rect(content_rect),
            "contentViewFrame": content_view,
            "styleMask": ns.styleMask().0,
            "isZoomed": ns.isZoomed(),
            "isMiniaturized": ns.isMiniaturized(),
            "isVisible": ns.isVisible(),
            "isOnActiveSpace": ns.isOnActiveSpace(),
            "isKeyWindow": ns.isKeyWindow(),
            "occlusionState": ns.occlusionState().0,
            "backingScaleFactor": ns.backingScaleFactor(),
            "contentMinSize": size(ns.contentMinSize()),
            "contentMaxSize": size(ns.contentMaxSize()),
            "screen": screen,
        })
    }
}

/// Full dump (tao + AppKit). Must run on the main thread on macOS.
fn full_dump_on_main<R: Runtime>(app: &AppHandle<R>, tag: &str, extra: Value) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log_record(app, tag, json!({ "window": null, "extra": extra }));
        return;
    };
    #[cfg(target_os = "macos")]
    let appkit = appkit::snapshot(&window);
    #[cfg(not(target_os = "macos"))]
    let appkit = Value::Null;
    log_record(
        app,
        tag,
        json!({ "tao": tao_snapshot(&window), "appkit": appkit, "extra": extra }),
    );
}

fn schedule_full_dump<R: Runtime>(app: &AppHandle<R>, tag: &'static str, extra: Value) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || full_dump_on_main(&handle, tag, extra));
}

/// Wire-up for `Builder::on_window_event`. Events arrive on the event loop
/// thread, so the AppKit dump is taken inline for geometry events.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    let app = window.app_handle();
    let label = window.label().to_owned();
    match event {
        WindowEvent::Resized(size) => {
            log_record(
                app,
                "event:resized",
                json!({ "label": label, "size": [size.width, size.height] }),
            );
            if label == MAIN_WINDOW {
                let anomaly = size.width < ANOMALY_PX || size.height < ANOMALY_PX;
                full_dump_on_main(
                    app,
                    if anomaly {
                        "anomaly:resized"
                    } else {
                        "dump:resized"
                    },
                    json!({ "size": [size.width, size.height] }),
                );
            }
        }
        WindowEvent::Moved(position) => {
            log_record(
                app,
                "event:moved",
                json!({ "label": label, "position": [position.x, position.y] }),
            );
            if label == MAIN_WINDOW {
                full_dump_on_main(app, "dump:moved", json!(null));
            }
        }
        WindowEvent::CloseRequested { .. } => {
            log_record(app, "event:close-requested", json!({ "label": label }));
        }
        WindowEvent::Destroyed => {
            log_record(app, "event:destroyed", json!({ "label": label }));
        }
        WindowEvent::Focused(focused) => {
            log_record(
                app,
                "event:focused",
                json!({ "label": label, "focused": focused }),
            );
        }
        WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
            log_record(
                app,
                "event:scale-changed",
                json!({ "label": label, "scaleFactor": scale_factor }),
            );
        }
        _ => {}
    }
}

/// Wire-up for the `Builder::run` callback: logs run-loop milestones and
/// takes the exit-moment dump (the exact read the window-state plugin
/// persists happens during `RunEvent::Exit`).
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        RunEvent::Ready => {
            log_record(app, "run:ready", json!(null));
            full_dump_on_main(app, "dump:ready", json!(null));
        }
        RunEvent::ExitRequested { code, .. } => {
            log_record(app, "run:exit-requested", json!({ "code": code }));
        }
        RunEvent::Exit => {
            // Same thread and moment as the plugin's own exit-time read.
            full_dump_on_main(app, "dump:exit", json!(null));
            if let Some(path) = state_file(app) {
                let content = std::fs::read_to_string(path).ok();
                log_record(
                    app,
                    "state-file:at-exit-before-save",
                    json!({ "content": content }),
                );
            }
        }
        _ => {}
    }
}

fn os_version() -> Value {
    let read = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("sw_vers")
            .args(args)
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    json!({
        "productVersion": read(&["-productVersion"]),
        "buildVersion": read(&["-buildVersion"]),
    })
}

fn monitors<R: Runtime>(app: &AppHandle<R>) -> Value {
    match app.available_monitors() {
        Ok(list) => json!(list
            .iter()
            .map(|monitor| {
                json!({
                    "name": monitor.name(),
                    "size": [monitor.size().width, monitor.size().height],
                    "position": [monitor.position().x, monitor.position().y],
                    "scaleFactor": monitor.scale_factor(),
                })
            })
            .collect::<Vec<_>>()),
        Err(err) => json!({ "error": err.to_string() }),
    }
}

/// Counts this launch and returns the number of launches so far.
fn count_launch<R: Runtime>(app: &AppHandle<R>) -> u64 {
    let Some(dir) = probe_dir(app) else { return 0 };
    let path = dir.join("launches.txt");
    let n: u64 = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
        + 1;
    let _ = std::fs::write(&path, n.to_string());
    n
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("window-probe")
        .setup(|app, _api| {
            let handle = app.clone();
            let launches = count_launch(&handle);
            #[cfg(target_os = "macos")]
            let appkit_version = unsafe { objc2_app_kit::NSAppKitVersionNumber };
            #[cfg(not(target_os = "macos"))]
            let appkit_version = 0.0;
            let state = state_file(&handle).and_then(|p| std::fs::read_to_string(p).ok());
            log_record(
                &handle,
                "boot",
                json!({
                    "appVersion": handle.package_info().version.to_string(),
                    "tauriVersion": tauri::VERSION,
                    "pinnedCrates": "tao 0.35.3 / wry 0.55.1 / tauri-plugin-window-state 2.4.1 (Cargo.lock)",
                    "os": os_version(),
                    "appKitVersion": appkit_version,
                    "monitors": monitors(&handle),
                    "launches": launches,
                    "args": std::env::args().collect::<Vec<_>>(),
                    "stateFileBeforeRestore": state,
                }),
            );
            if launches > MAX_LAUNCHES {
                log_record(&handle, "abort", json!({ "reason": "launch cap reached" }));
                handle.exit(0);
                return Ok(());
            }
            spawn_sampler(handle.clone());
            spawn_scenario_runner(handle);
            Ok(())
        })
        .build()
}

/// Every 250ms: log a full dump when the tao-level geometry changed, and
/// archive `.window-state.json` whenever its content changed.
fn spawn_sampler<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let mut last_geometry = String::new();
        let mut last_state = String::new();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let snapshot = tao_snapshot(&window);
                let serialized = snapshot.to_string();
                if serialized != last_geometry {
                    last_geometry = serialized;
                    let inner = window.inner_size().ok();
                    let anomaly = inner
                        .map(|s| s.width < ANOMALY_PX || s.height < ANOMALY_PX)
                        .unwrap_or(false);
                    schedule_full_dump(
                        &app,
                        if anomaly {
                            "anomaly:sampler"
                        } else {
                            "dump:sampler"
                        },
                        json!(null),
                    );
                }
            }
            if let Some(path) = state_file(&app) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content != last_state {
                        last_state = content.clone();
                        log_record(&app, "state-file:changed", json!({ "content": content }));
                        if let Some(dir) = probe_dir(&app) {
                            let history = dir.join("state-history");
                            let _ = std::fs::create_dir_all(&history);
                            let _ =
                                std::fs::write(history.join(format!("{}.json", now_ms())), content);
                        }
                    }
                }
            }
        }
    });
}

fn spawn_scenario_runner<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || run_scenario(app));
}

/// One scenario per launch: read `plan.txt`, execute the step at
/// `progress.txt`, advance it, then relaunch (the same
/// `AppHandle::request_restart` path the updater uses) or exit.
fn run_scenario<R: Runtime>(app: AppHandle<R>) {
    let Some(dir) = probe_dir(&app) else { return };
    let Ok(plan) = std::fs::read_to_string(dir.join("plan.txt")) else {
        log_record(&app, "plan", json!({ "mode": "manual (no plan.txt)" }));
        return;
    };
    let steps: Vec<&str> = plan
        .lines()
        .map(|line| line.split('#').next().unwrap_or("").trim())
        .filter(|line| !line.is_empty())
        .collect();
    let progress: usize = std::fs::read_to_string(dir.join("progress.txt"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let Some(step) = steps.get(progress).copied() else {
        log_record(&app, "plan", json!({ "done": true }));
        let _ = std::fs::write(dir.join("done"), "done");
        app.exit(0);
        return;
    };
    let _ = std::fs::write(dir.join("progress.txt"), (progress + 1).to_string());
    log_record(
        &app,
        "scenario:start",
        json!({ "step": step, "index": progress }),
    );

    // Let the page-load reveal and the window-state restore settle first.
    std::thread::sleep(Duration::from_millis(1500));
    let window = app.get_webview_window(MAIN_WINDOW);
    let act = |action: &str, result: tauri::Result<()>| {
        log_record(
            &app,
            "scenario:action",
            json!({ "action": action, "error": result.err().map(|e| e.to_string()) }),
        );
    };
    let mut restart = true;
    match (step, window) {
        ("plain", _) => std::thread::sleep(Duration::from_millis(700)),
        ("zoom", Some(w)) => {
            act("maximize", w.maximize());
            std::thread::sleep(Duration::from_millis(1200));
        }
        ("zoom-race", Some(w)) => act("maximize", w.maximize()),
        ("unzoom", Some(w)) => {
            act("unmaximize", w.unmaximize());
            std::thread::sleep(Duration::from_millis(1200));
        }
        ("unzoom-race", Some(w)) => act("unmaximize", w.unmaximize()),
        ("hidden", Some(w)) => {
            act("hide", w.hide());
            std::thread::sleep(Duration::from_millis(1000));
        }
        ("minimized", Some(w)) => {
            act("minimize", w.minimize());
            std::thread::sleep(Duration::from_millis(1000));
        }
        ("fullscreen", Some(w)) => {
            act("fullscreen", w.set_fullscreen(true));
            std::thread::sleep(Duration::from_millis(2000));
        }
        ("fullscreen-exit-race", Some(w)) => {
            act("fullscreen", w.set_fullscreen(true));
            std::thread::sleep(Duration::from_millis(2000));
            act("unfullscreen", w.set_fullscreen(false));
            std::thread::sleep(Duration::from_millis(250));
        }
        ("wait-user", _) => {
            // An external driver (or a human) acts on the window now; the
            // run.sh script performs real tiling here. Continue on signal.
            let _ = std::fs::write(dir.join("phase"), "waiting-user");
            let deadline = SystemTime::now() + Duration::from_secs(300);
            while !dir.join("continue").exists() && SystemTime::now() < deadline {
                std::thread::sleep(Duration::from_millis(300));
            }
            let _ = std::fs::remove_file(dir.join("continue"));
            let _ = std::fs::remove_file(dir.join("phase"));
        }
        ("done", _) => {
            let _ = std::fs::write(dir.join("done"), "done");
            restart = false;
        }
        (other, _) => {
            log_record(&app, "scenario:unknown", json!({ "step": other }));
        }
    }
    log_record(
        &app,
        "scenario:end",
        json!({ "step": step, "restart": restart }),
    );
    if restart {
        app.request_restart();
    } else {
        app.exit(0);
    }
}
