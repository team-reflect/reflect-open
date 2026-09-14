import { emitFileChanges } from '../indexing/file-changes'
import { readArchivedPost, writeArchivedPost } from './commands'
import { mergeArchivedPost } from './resources'
import type { ArchivedXPost } from './types'
export async function saveArchivedPost(generation: number, incoming: ArchivedXPost): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = (await readArchivedPost(generation, incoming.id)) ?? undefined
    const next = mergeArchivedPost(previous, incoming)
    if (next === previous) return
    if (await writeArchivedPost(generation, incoming.id, previous?.revision ?? null, next)) {
      emitFileChanges([{ path: 'assets/x/post-' + incoming.id + '.json', kind: 'upsert' }])
      return
    }
  }
  throw new Error('archive-revision-conflict')
}
