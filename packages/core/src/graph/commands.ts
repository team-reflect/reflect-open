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

/** The recently-opened graphs, newest first. */
export async function recentGraphs(): Promise<RecentGraph[]> {
  return call('recent_graphs', {}, z.array(recentGraphSchema))
}

/** Drop a graph from the recents list (by root path). */
export async function forgetRecent(root: string): Promise<void> {
  await call('forget_recent', { root }, voidSchema)
}
