# Logging

Where log lines go, how to write one, and what must never be in one.

## Where lines end up

[`tauri-plugin-log`](https://v2.tauri.app/plugin/logging/) owns the sinks
(`apps/desktop/src-tauri/src/logging.rs`): stderr (the OS log on mobile) and
`reflect.log` under the OS log directory (`~/Library/Logs/<bundle id>/` on
macOS). The file rotates at 5 MB and three rotated files are kept. Timestamps
are UTC. A user who hits a problem can send that folder; nobody has to
relaunch the app from a terminal.

- **Rust** uses `tracing`. No `tracing` subscriber is installed: the crate's
  `log` feature turns every event into a `log` record, with fields rendered
  as `key=value` after the message.
- **TypeScript** logs through the injected `LoggerService` (`deps.logger`,
  see [services](services.md)). In the native shell, `boot.ts` builds it with
  `createTauriLogger` (`apps/desktop/src/services/tauri-logger.ts`): every
  line goes to the console and to `@tauri-apps/plugin-log`, under a target
  that starts with `webview`. The cause is rendered into the message: an
  error as `Name: message`, any other value as JSON, cut at 2000 characters.
  TypeScript and Rust lines therefore sort together in one file. Plain-browser
  dev and tests log to the console or the test logger only.
- `RUST_LOG` sets one global level for both sinks (`info` by default).
  Per-target directives are not supported.
- The logger starts in the Tauri `setup` hook. Lines logged before that are
  dropped.

## Writing a line

```ts
logger.info('embedding backfill finished', { outcome, notes, chunksEmbedded, elapsedMs })
logger.error(`embedding backfill failed for ${row.path}:`, cause)
```

- The message says what happened; the second argument carries the error or
  the payload behind it.
- Long operations log **one summary at the end** with an outcome, counts and
  `elapsedMs` (see `EmbeddingIndexService.backfill`, or `git_commit_all` on
  the Rust side). Do not log one line per item: a backfill over 2.5k notes
  must not produce 2.5k lines.

In Rust the same shape is `tracing::info!(committed, ahead, elapsed_ms, "git_commit_all")`.

## What must not be logged

The log directory is outside the graph and outside the `private: true` guard.
Lines may carry note paths, counts, durations, and error messages, but never
note text or anything derived from note content. This includes the cause:
do not pass an object that holds note text. Error messages from providers can
quote request data; pass the error, not the raw response body.
