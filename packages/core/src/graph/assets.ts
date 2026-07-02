import { z } from 'zod'
import { echoLocalWrite } from '../indexing/local-write-echo'
import { call, callBinary } from '../ipc/invoke'

/** Commands that return `()` from Rust serialize as `null` over IPC. */
const voidSchema = z.null()

/**
 * Upload chunk size. Big enough that a large file doesn't drown in IPC
 * round-trips, small enough that webview memory holds one chunk — never the
 * whole file (the point of streaming over the old base64-the-lot route).
 */
const CHUNK_BYTES = 4 * 1024 * 1024

/** The header carrying the upload id on raw-body append calls. */
const UPLOAD_ID_HEADER = 'x-upload-id'

async function* chunksOf(contents: Blob): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < contents.size; offset += CHUNK_BYTES) {
    yield new Uint8Array(await contents.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
  }
}

/**
 * Stream a pasted/dropped file's bytes into the graph's `assets/` folder as
 * `desiredName` — or the first free `-2`-suffixed variant; Rust decides the
 * final name race-free and returns it as a graph-relative `assets/…` path.
 * Bytes travel as raw binary IPC bodies in {@link CHUNK_BYTES} chunks staged
 * under `.reflect/tmp/`, so neither webview memory nor the file watcher ever
 * sees the whole file in flight. `generation` pins the write to the graph it
 * was issued for; a failure aborts the upload (best-effort) and rethrows.
 */
export async function createAsset(
  desiredName: string,
  contents: Blob,
  generation: number,
): Promise<string> {
  const id = await call('asset_upload_begin', { generation }, z.string())
  try {
    for await (const chunk of chunksOf(contents)) {
      await callBinary('asset_upload_append', chunk, { [UPLOAD_ID_HEADER]: id }, voidSchema)
    }
    const path = await call('asset_upload_commit', { id, desiredName, generation }, z.string())
    echoLocalWrite({ path, kind: 'upsert', modifiedMs: Date.now() })
    return path
  } catch (error) {
    // Best-effort cleanup of the staged temp file; the original error is the
    // one worth surfacing.
    await call('asset_upload_abort', { id }, voidSchema).catch(() => {})
    throw error
  }
}

/**
 * Copy a file the OS handed us a real path for (file picker) into the graph's
 * `assets/` folder as `desiredName`, with the same collision policy and
 * return value as {@link createAsset}. The copy happens file-to-file in Rust;
 * the bytes never enter webview memory.
 */
export async function importAsset(
  sourcePath: string,
  desiredName: string,
  generation: number,
): Promise<string> {
  const path = await call('asset_import', { sourcePath, desiredName, generation }, z.string())
  echoLocalWrite({ path, kind: 'upsert', modifiedMs: Date.now() })
  return path
}
