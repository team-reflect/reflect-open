import { emitFileChanges } from '../indexing/file-changes'
import { readArchivedPost, writeArchivedPost } from './commands'
import { mergeArchivedPost } from './resources'
import type { ArchivedXPost } from './types'
export async function saveArchivedPost(generation: number, incoming: ArchivedXPost): Promise<void> {
  // FIXME: the 8-attempt compare-and-swap loop and the `expected` revision guard in Rust
  // `write_post` protect against a race that cannot happen: only `drainCaptureInbox` writes
  // `assets/x/post-*.json`, sequentially, in one process (the extension and the native host never
  // touch post JSON). Read, merge, write once; drop `expected` from `x_archive_write`.
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
