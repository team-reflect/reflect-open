# Logging

`tauri-plugin-log` (`apps/desktop/src-tauri/src/logging.rs`) writes to stderr
and to `reflect.log` in the OS log directory (`~/Library/Logs/<bundle id>/` on
macOS). The file rotates at 5 MB and keeps three rotated files. Timestamps are
UTC.

- Rust: `tracing::*`. The `tracing` crate's `log` feature turns each event into
  a `log` record, with fields as `key=value`.
- TypeScript: the injected `LoggerService`. In the native shell it is
  `createTauriLogger` (`apps/desktop/src/services/tauri-logger.ts`), which
  writes to the console and to `@tauri-apps/plugin-log`. The cause is appended
  to the message: an error as `Name: message`, other values as JSON, cut at
  2000 characters.
- `RUST_LOG` sets one global level (default `info`). Per-target directives are
  not supported.
- Lines logged before the Tauri `setup` hook are dropped.
- A long operation logs one summary line when it ends, with its outcome,
  counts, and `elapsedMs`, not one line per item.
