import { isAssetPath, isNotePath } from '../graph/paths.ts'
import type { Unlisten } from '../unlisten.ts'
import type { DirtySet } from './dirty-set.ts'
import type { FileChangeService } from './file-change-service.ts'

/**
 * Mark every note and asset file that the file-change stream reports as
 * dirty. Other files of the stream (audio-memo recordings) are skipped.
 */
export function followFileChanges(fileChanges: FileChangeService, dirty: DirtySet): Unlisten {
  return fileChanges.subscribe(({ changes }) => {
    for (const change of changes) {
      if (isNotePath(change.path) || isAssetPath(change.path)) {
        dirty.add(change.path, { kind: change.kind, modifiedMs: change.modifiedMs })
      }
    }
  })
}
