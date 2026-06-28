import { z } from 'zod'
import { echoLocalWrite } from '../indexing/local-write-echo'
import { call } from '../ipc/invoke'
import {
  fileMetaSchema,
  graphInfoSchema,
  recentGraphSchema,
  type FileMeta,
  type GraphInfo,
  type RecentGraph,
} from './schemas'

/** Commands that return `()` from Rust serialize as `null` over IPC. */
const voidSchema = z.null()

/** Open an existing graph at `path` (ensures the standard layout exists). */
export async function openGraph(path: string): Promise<GraphInfo> {
  return call('graph_open', { path }, graphInfoSchema)
}

/** Create a new graph at `path` and open it. */
export async function createGraph(path: string): Promise<GraphInfo> {
  return call('graph_create', { path }, graphInfoSchema)
}

/**
 * Read a note's markdown by graph-relative path. `generation`, when given,
 * pins the read to the issuing graph session — background passes that can
 * span a graph switch must pin every read; UI reads of the open graph omit it.
 */
export async function readNote(path: string, generation?: number): Promise<string> {
  return call('note_read', { path, generation }, z.string())
}

/**
 * Atomically write a note's markdown by graph-relative path. `generation` (from
 * `GraphInfo`) pins the write to the graph it was issued for — Rust rejects it
 * if the graph switched in between.
 */
export async function writeNote(path: string, contents: string, generation: number): Promise<void> {
  await call('note_write', { path, contents, generation }, voidSchema)
  echoLocalWrite({ path, kind: 'upsert', modifiedMs: Date.now() })
}

/**
 * Atomically write a binary asset (pasted/dropped image) by graph-relative
 * path. `contentsBase64` is the file's bytes, base64-encoded for the JSON IPC.
 */
export async function writeAsset(
  path: string,
  contentsBase64: string,
  generation: number,
): Promise<void> {
  await call('asset_write', { path, contentsBase64, generation }, voidSchema)
  echoLocalWrite({ path, kind: 'upsert', modifiedMs: Date.now() })
}

/**
 * Read a binary asset's bytes by graph-relative path, base64-encoded (the IPC
 * is JSON). E.g. an audio memo read back for transcription. `generation` pins
 * the read: background passes can span a graph switch, and an unpinned read
 * would resolve against the new graph's same-named file.
 */
export async function readAsset(path: string, generation: number): Promise<string> {
  return call('asset_read', { path, generation }, z.string())
}

/**
 * Open an asset by graph-relative path in the system default application.
 * `generation` pins the request to the graph whose markdown produced the
 * image, so a delayed click after a graph switch cannot open another graph's
 * same-named file.
 */
export async function openAsset(path: string, generation: number): Promise<void> {
  await call('asset_open', { path, generation }, voidSchema)
}

/**
 * List every file (any extension) under a graph-relative directory, e.g.
 * `audio-memos`. A missing directory lists as empty. Pinned to `generation`
 * for the same reason as {@link readAsset}.
 */
export async function listDir(dir: string, generation: number): Promise<FileMeta[]> {
  return call('dir_list', { dir, generation }, z.array(fileMetaSchema))
}

/**
 * Does a graph-relative path currently exist as a file on disk? Probes the
 * filesystem directly — unlike an index lookup, this can't lag the watcher.
 */
export async function noteExists(path: string): Promise<boolean> {
  return call('note_exists', { path }, z.boolean())
}

/** Send a note to the OS trash (recoverable; pinned to `generation`). */
export async function deleteNote(path: string, generation: number): Promise<void> {
  await call('note_delete', { path, generation }, voidSchema)
  echoLocalWrite({ path, kind: 'remove' })
}

/**
 * List markdown notes under `daily/` and `notes/`. `generation` pins the
 * listing like {@link readNote}'s.
 */
export async function listFiles(generation?: number): Promise<FileMeta[]> {
  return call('list_files', { generation }, z.array(fileMetaSchema))
}

/**
 * Point the capture host at the active graph (pointer file + inbox dir) and
 * rewrite native-messaging manifests for detected browsers. Called after
 * every graph open — rewriting self-heals app moves (Plan 11).
 */
export async function captureHostRegister(): Promise<void> {
  await call('capture_host_register', {}, voidSchema)
}

/**
 * List the capture inbox (`.reflect/inbox/`): spooled `.json` envelopes and
 * their screenshot siblings. A missing inbox lists as empty. Pinned to
 * `generation` like every background-pass read.
 */
export async function captureInboxList(generation: number): Promise<FileMeta[]> {
  return call('capture_inbox_list', { generation }, z.array(fileMetaSchema))
}

/** Read one spooled envelope's JSON text by spool filename (e.g. `<id>.json`). */
export async function captureInboxRead(name: string, generation: number): Promise<string> {
  return call('capture_inbox_read', { name, generation }, z.string())
}

/** Remove a spool file by filename. Idempotent — crash re-drains re-remove. */
export async function captureInboxRemove(name: string, generation: number): Promise<void> {
  await call('capture_inbox_remove', { name, generation }, voidSchema)
}

/**
 * Quarantine an unparseable spool file into `.reflect/inbox-rejected/` —
 * moved, never deleted: "the raw link is never lost" holds even for an
 * envelope a newer extension wrote that this app version can't read yet.
 */
export async function captureInboxReject(name: string, generation: number): Promise<void> {
  await call('capture_inbox_reject', { name, generation }, voidSchema)
}

/**
 * Copy a spooled screenshot into the graph as a downscaled JPEG asset (the
 * spool file stays until the drain removes it — crash-safe copy semantics).
 */
export async function promoteCaptureScreenshot(
  spoolName: string,
  assetPath: string,
  maxDim: number,
  generation: number,
): Promise<void> {
  await call('capture_screenshot_promote', { spoolName, assetPath, maxDim, generation }, voidSchema)
}

/**
 * Fetch a captured page's HTML for meta-tag scraping — the Rust side caps
 * scheme/timeout/size/redirects, so arbitrary capture URLs never widen the
 * webview's own HTTP capability. The privacy gate runs before any call here.
 */
export async function captureMetaFetch(url: string): Promise<string> {
  return call('capture_meta_fetch', { url }, z.string())
}

/** The recently-opened graphs, newest first. */
export async function recentGraphs(): Promise<RecentGraph[]> {
  return call('recent_graphs', {}, z.array(recentGraphSchema))
}

/** Drop a graph from the recents list (by root path). */
export async function forgetRecent(root: string): Promise<void> {
  await call('forget_recent', { root }, voidSchema)
}
