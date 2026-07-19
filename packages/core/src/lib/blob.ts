/**
 * Walk a Blob in fixed-size slices, in order, covering every byte exactly
 * once (the final slice may be short). Slicing is O(1) — each yielded Blob is
 * a view, and its bytes materialize only when a consumer reads them — so
 * iterating a multi-hundred-megabyte recording never holds more than one
 * materialized chunk at a time. Shared by the streamed asset upload
 * (`graph/assets`) and the Gemini Files API upload (`ai/gemini-files`),
 * which choose their own chunk sizes.
 */
export function* blobChunks(blob: Blob, chunkBytes: number): Generator<Blob> {
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    yield blob.slice(offset, offset + chunkBytes)
  }
}
