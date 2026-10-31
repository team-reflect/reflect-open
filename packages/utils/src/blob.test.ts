import { describe, expect, it } from 'vitest'
import { blobChunks } from './index.ts'

describe('blobChunks', () => {
  it.each([1, 3, 10, 20])('preserves all bytes with chunk size %i', async (chunkBytes) => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255, 6, 7, 8, 9])
    const chunks = [...blobChunks(new Blob([bytes]), chunkBytes)]
    expect(chunks).toHaveLength(Math.ceil(bytes.length / chunkBytes))
    for (const chunk of chunks) {
      expect(chunk.size).toBeGreaterThan(0)
      expect(chunk.size).toBeLessThanOrEqual(chunkBytes)
    }
    expect(new Uint8Array(await new Blob(chunks).arrayBuffer())).toEqual(bytes)
  })

  it('yields no chunks for an empty Blob', () => {
    expect([...blobChunks(new Blob([]), 3)]).toEqual([])
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid chunk size %s',
    (chunkBytes) => {
      expect(() => [...blobChunks(new Blob([]), chunkBytes)]).toThrow(RangeError)
    },
  )
})
