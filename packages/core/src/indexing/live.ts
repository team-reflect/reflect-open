import { isAssetPath, isNotePath } from '../graph/paths.ts'
import type { DirtySet } from './dirty-set.ts'
import type { FileChange } from './file-change-service.ts'

/**
 * Mark every note and asset file of `changes` dirty. Other files (audio-memo
 * recordings) are skipped.
 */
export function markFileChanges(dirty: DirtySet, changes: readonly FileChange[]): void {
  for (const change of changes) {
    if (isNotePath(change.path) || isAssetPath(change.path)) {
      dirty.add(change.path, { kind: change.kind, modifiedMs: change.modifiedMs })
    }
  }
}
