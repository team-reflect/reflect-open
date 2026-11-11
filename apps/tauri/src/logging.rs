//! Log sinks: stderr and a size-rotated `reflect.log` in the OS log
//! directory, both owned by `tauri-plugin-log`. With no `tracing` subscriber
//! installed, the `tracing` crate's `log` feature turns every event into a
//! `log` record. The webview logs through the plugin's `plugin:log|log`
//! command.

use log::LevelFilter;
use reflect_core::logging::{MAX_FILE_SIZE, MAX_ROTATED_FILES, level_from_env};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

/// Install the logger: stderr plus the log file, or stderr alone when the
/// log file cannot be opened. A missing log file must never block launch.
/// Lines logged before this call are dropped.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let level = level_from_env(std::env::var("RUST_LOG").ok().as_deref());
    if let Err(err) = app.plugin(plugin(level, true)) {
        if let Err(fallback_err) = app.plugin(plugin(level, false)) {
            eprintln!("logging unavailable: {fallback_err}");
            return;
        }
        tracing::warn!(error = %err, "log file unavailable; logging to stderr only");
    }
    tracing::info!(version = %app.package_info().version, "logging started");
}

fn plugin<R: Runtime>(level: LevelFilter, with_file: bool) -> TauriPlugin<R> {
    let mut targets = vec![Target::new(TargetKind::Stderr)];
    if with_file {
        targets.push(Target::new(TargetKind::LogDir {
            file_name: Some("reflect".to_string()),
        }));
    }
    tauri_plugin_log::Builder::new()
        .level(level)
        .targets(targets)
        .max_file_size(u128::from(MAX_FILE_SIZE))
        .rotation_strategy(RotationStrategy::KeepSome(MAX_ROTATED_FILES))
        .build()
}
