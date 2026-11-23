import { isAssetPath, isNotePath } from '../graph/paths.ts'
import type { FileChange } from './file-change-service.ts'
import type { IndexWriter } from './index-writer.ts'

/**
 * Mark every note and asset file of `changes` dirty. Other files (audio-memo
 * recordings) are skipped.
 */
export function markFileChanges(
  writer: Pick<IndexWriter, 'mark'>,
  changes: readonly FileChange[],
): void {
  for (const change of changes) {
    if (isNotePath(change.path) || isAssetPath(change.path)) {
      writer.mark(change.path, { kind: change.kind, modifiedMs: change.modifiedMs })
    }
  }
}
