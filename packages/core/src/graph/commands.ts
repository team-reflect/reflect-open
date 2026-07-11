import { z } from 'zod'
import { echoLocalWrite } from '../indexing/local-write-echo'
import { getBridge, type Unlisten } from '../ipc/bridge'
import { call } from '../ipc/invoke'
import {
  fileMetaSchema,
  graphImportProgressSchema,
  graphImportSummarySchema,
  graphInfoSchema,
  noteCreateOutcomeSchema,
  recentGraphSchema,
  windowBootstrapSchema,
  type FileMeta,
  type GraphImportProgress,
  type GraphImportSummary,
  type GraphInfo,
  type NoteCreateOutcome,
  type RecentGraph,
  type WindowBootstrap,
} from './schemas'

/** Commands that return `()` from Rust serialize as `null` over IPC. */
const voidSchema = z.null()

/** Open an existing graph at `path` (ensures the standard layout exists). */
export async function openGraph(path: string): Promise<GraphInfo> {
  return call('graph_open', { path }, graphInfoSchema)
}

/**
 * Open (or focus) a secondary note window on a `reflect://` route link
 * (⌘-click a note link). Desktop-only; requires an open graph, which the new
 * window adopts — see {@link windowBootstrap}.
 */
export async function openNoteWindow(deepLink: string): Promise<void> {
  await call('open_note_window', { deepLink }, voidSchema)
}

/**
 * Adopt the already-open graph for a secondary note window: a pure read of
 * the current graph + index sessions (never `graph_open`/`index_open`, whose
 * generation bumps would strand the main window's pinned commands) plus the
 * one-shot deep link the window was created for. Errors when no graph is open.
 */
export async function windowBootstrap(): Promise<WindowBootstrap> {
  return call('window_bootstrap', {}, windowBootstrapSchema)
}

/**
 * Close every note window and wait (bounded) for their flushes to land.
 * Call BEFORE anything that bumps the graph/index generations (switch,
 * delete): note windows adopted the outgoing session, and a bump-first
 * ordering would reject their final saves as stale.
 */
export async function closeNoteWindows(): Promise<void> {
  await call('close_note_windows', {}, voidSchema)
}

/** Create a new graph at `path` and open it. */
export async function createGraph(path: string): Promise<GraphInfo> {
  return call('graph_create', { path }, graphInfoSchema)
}

/**
 * Import a Reflect V1 export `.zip` into the open graph. V1 exports already use
 * Reflect Open's graph-folder layout; Rust extracts safe entries under the
 * active graph root without ever replacing an existing file (identical files
 * skip, conflicting notes rename, conflicting daily notes merge). Attachments
 * the notes link to on Firebase Storage or Reflect's asset CDN are downloaded
 * into `assets/` and the links rewritten, so the call can take a while on
 * attachment-heavy graphs — observe {@link subscribeImportProgress} and offer
 * {@link cancelReflectV1Import} while it runs.
 */
export async function importReflectV1Zip(
  path: string,
  generation: number,
): Promise<GraphImportSummary> {
  return call('graph_import_reflect_v1_zip', { path, generation }, graphImportSummarySchema)
}

/** Event name the running import emits {@link GraphImportProgress} ticks on. */
export const IMPORT_PROGRESS_EVENT = 'import:progress'

/** Live progress ticks of the running Reflect V1 import. */
export function subscribeImportProgress(
  handler: (progress: GraphImportProgress) => void,
): Promise<Unlisten> {
  return getBridge().listen(IMPORT_PROGRESS_EVENT, (payload) => {
    const parsed = graphImportProgressSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid import:progress payload:', parsed.error)
    }
  })
}

/**
 * Cancel the running Reflect V1 import (a no-op when none runs). The import
 * aborts before anything lands in the graph, so cancelling is always safe;
 * the pending {@link importReflectV1Zip} call rejects.
 */
export async function cancelReflectV1Import(): Promise<void> {
  await call('graph_import_cancel', {}, voidSchema)
}

/**
 * Mark files imported by {@link importReflectV1Zip} as this device's writes.
 * Call only after the UI confirms the imported graph is still the active graph:
 * these paths are graph-relative and the own-write channel is scoped to the
 * currently running iCloud controller.
 */
export function markReflectV1ImportOwnWrites(summary: GraphImportSummary): void {
  const modifiedMs = Date.now()
  for (const changedPath of summary.changedPaths) {
    echoLocalWrite({ path: changedPath, kind: 'upsert', modifiedMs })
  }
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
 *
 * The echo carries the file's on-disk mtime, which Rust returns from the
 * write: the index row it produces must compare equal to a later `listFiles`
 * mtime, or the reconcile's read-free skip never fires and the note is
 * re-read on every pass. `Date.now()` is a fallback for a platform that
 * can't report one.
 */
export async function writeNote(path: string, contents: string, generation: number): Promise<void> {
  const modifiedMs = await call('note_write', { path, contents, generation }, z.number().nullable())
  echoLocalWrite({ path, kind: 'upsert', modifiedMs: modifiedMs ?? Date.now() })
}

/**
 * Atomically create a note only if `path` is still unoccupied. A collision is
 * returned as data and never overwrites the winner, closing the race between a
 * caller's availability check and a concurrent sync checkout or creator.
 */
export async function createNoteIfAbsent(
  path: string,
  contents: string,
  generation: number,
): Promise<NoteCreateOutcome> {
  const outcome = await call(
    'note_create',
    { path, contents, generation },
    noteCreateOutcomeSchema,
  )
  if (outcome.kind === 'created') {
    echoLocalWrite({ path, kind: 'upsert', modifiedMs: outcome.modifiedMs ?? Date.now() })
  }
  return outcome
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

/**
 * Spool an envelope this app produced (deep-link text captures) into the
 * inbox, atomically — it then flows through the same watcher-triggered drain
 * as browser captures. The caller validates the envelope shape; the Rust side
 * only moves bytes (with a defensive size cap).
 */
export async function captureInboxSpool(
  name: string,
  json: string,
  generation: number,
): Promise<void> {
  await call('capture_inbox_spool', { name, json, generation }, voidSchema)
}

/** Remove a spool file by filename. Idempotent — crash re-drains re-remove. */
export async function captureInboxRemove(name: string, generation: number): Promise<void> {
  await call('capture_inbox_remove', { name, generation }, voidSchema)
}

/**
 * Relay envelopes the iOS share extension spooled into the App Group inbox
 * into the graph's capture inbox, returning how many moved. iOS-only in
 * effect (elsewhere there is no shared container and the relay is zero);
 * called by the mobile capture controller before every drain pass.
 */
export async function captureSharedInboxRelay(generation: number): Promise<number> {
  return call('capture_shared_inbox_relay', { generation }, z.number())
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

/**
 * Move the open graph's whole directory to the OS trash (recoverable) and
 * drop it from recents. Pinned to `generation` so a delete can never race a
 * graph switch and trash the newly opened graph. Desktop-only.
 */
export async function deleteGraph(generation: number): Promise<void> {
  await call('graph_delete', { generation }, voidSchema)
}
