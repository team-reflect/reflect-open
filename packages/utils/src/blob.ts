/** Yield consecutive Blob slices. The final slice can be smaller than chunkBytes. */
export function* blobChunks(blob: Blob, chunkBytes: number): Generator<Blob> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError('chunkBytes must be a positive integer')
  }
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    yield blob.slice(offset, offset + chunkBytes)
  }
}
