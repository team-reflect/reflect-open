import { isAssetPath, isNotePath } from '../graph/paths.ts'
import type { Unlisten } from '../unlisten.ts'
import type { DirtySet } from './dirty-set.ts'
import type { FileChange, FileChangeService } from './file-change-service.ts'

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

/**
 * Mark the files that the file-change stream reports as dirty, by {@link markFileChanges}.
 */
export function followFileChanges(fileChanges: FileChangeService, dirty: DirtySet): Unlisten {
  return fileChanges.subscribe(({ changes }) => {
    markFileChanges(dirty, changes)
  })
}
