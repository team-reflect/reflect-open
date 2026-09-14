import { emitFileChanges } from '../indexing/file-changes'
import { writeArchivedPost } from './commands'
import type { ArchivedXPost } from './types'

export async function saveArchivedPost(generation: number, incoming: ArchivedXPost): Promise<void> {
  // Native code selects and saves the capture under the same lock as Git merge.
  await writeArchivedPost(generation, incoming)
  // FIXME: this manual echo only feeds the card subscription; it goes away with the
  // subscribe/revision mechanism (see the FIXME in apps/desktop/src/editor/use-x-post-resolver.ts).
  emitFileChanges([{ path: 'assets/x/post-' + incoming.data.id + '.json', kind: 'upsert' }])
}
