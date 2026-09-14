// FIXME: five files of 8 to 26 lines plus this barrel; merge them into one `x-archive.ts`. While
// doing so delete what has no caller left: `readArchivedPost` and the `x_archive_read` command
// (commands.ts, desktop `fs/x_archive.rs`, `lib.rs` handler list), `parseArchivedPost` (schema.ts),
// and `VIDEO_MAX_BYTES`/`IMAGE_MAX_BYTES` (types.ts; only Rust uses them). Also
// `packages/core/src/index.ts` re-exports this module at the root while package.json exposes it as
// the `./x-archive` subpath and every caller uses the subpath; keep one.
export * from './types'
export * from './schema'
export * from './resources'
export * from './commands'
export * from './store'
