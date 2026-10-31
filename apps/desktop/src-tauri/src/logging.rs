//! Log sinks: stderr and a size-rotated `reflect.log` in the OS log
//! directory, both owned by `tauri-plugin-log`. With no `tracing` subscriber
//! installed, the `tracing` crate's `log` feature turns every event into a
//! `log` record. The webview logs through the plugin's `plugin:log|log`
//! command.

use log::LevelFilter;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

/// `reflect.log` rotates once it reaches this size.
const MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;

/// Rotated files to keep next to the active one.
const MAX_ROTATED_FILES: usize = 3;

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
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(MAX_ROTATED_FILES))
        .build()
}

/// `RUST_LOG` as one global level (`debug`, `warn`, ...), `info` otherwise.
/// Per-target directives (`reflect_open::git=debug`) are not supported.
fn level_from_env(value: Option<&str>) -> LevelFilter {
    value
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(LevelFilter::Info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_from_env_parses_one_level_or_defaults_to_info() {
        assert_eq!(level_from_env(None), LevelFilter::Info);
        assert_eq!(level_from_env(Some("debug")), LevelFilter::Debug);
        assert_eq!(level_from_env(Some("WARN")), LevelFilter::Warn);
        assert_eq!(
            level_from_env(Some("reflect_open::git=debug")),
            LevelFilter::Info
        );
    }
}
