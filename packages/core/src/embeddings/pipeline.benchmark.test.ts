import { test, expect } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { backfillEmbeddings } from './pipeline'
import { chunkNote } from './chunk'
import { hashContent } from '../indexing/hash'

test('incremental embedding backfill work counts', async () => {
  const content =
    '# Daily planning\n\n' +
    Array.from(
      { length: 12 },
      (_, index) =>
        `- Task ${index}: Follow up with the project team about design decisions and implementation details.\n`,
    ).join('')
  const chunks = await chunkNote('notes/example.md', content)
  const fileHash = await hashContent(content)
  const results = []
  for (const count of [1_000, 10_000]) {
    for (const dirtyCount of [0, 10]) {
      const notes = Array.from({ length: count }, (_, index) => ({
        path: `notes/${index}.md`,
        fingerprint: fileHash,
        dirty: index < dirtyCount,
      }))
      const stats = {
        candidateQueries: 0,
        prepares: 0,
        noteReads: 0,
        chunkQueries: 0,
        applies: 0,
        inferences: 0,
      }
      setBridge({
        listen: async () => () => {},
        invoke: async (command) => {
          if (command === 'embed_pending') {
            stats.candidateQueries++
            return notes
              .filter((note) => note.dirty)
              .map(({ path, fingerprint }) => ({ path, fingerprint }))
          }
          if (command === 'embed_prepare') {
            stats.prepares++
            return { fingerprint: fileHash, fileHash, assetPaths: [] }
          }
          if (command === 'embed_read') {
            stats.noteReads++
            return { kind: 'content', content }
          }
          if (command === 'db_query') {
            stats.chunkQueries++
            return chunks.map((chunk) => ({
              content_hash: chunk.contentHash,
              model_id: 'test-model',
            }))
          }
          if (command === 'embed_apply') {
            stats.applies++
            return null
          }
          if (command === 'embed_texts') {
            stats.inferences++
            throw new Error('Unexpected inference')
          }
          throw new Error('Unexpected ' + command)
        },
      })
      const start = performance.now()
      await backfillEmbeddings({ generation: 1, modelId: 'test-model' })
      const result = {
        notes: count,
        dirtyNotes: dirtyCount,
        contentBytes: content.length,
        chunks: chunks.length,
        milliseconds: performance.now() - start,
        ...stats,
      }
      expect(stats).toEqual({
        candidateQueries: 1,
        prepares: dirtyCount,
        noteReads: dirtyCount,
        chunkQueries: dirtyCount,
        applies: dirtyCount,
        inferences: 0,
      })
      results.push(result)
      console.log('BACKFILL', JSON.stringify(result))
    }
  }
  setBridge(null)
})
