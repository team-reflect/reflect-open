import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { expect } from 'vitest'
import { AppError } from '../errors.ts'
import { createNoteFileService } from '../graph/note-file-service.ts'
import { normalizeWikiTarget, parseNote } from '../markdown/index.ts'
import { createTestClockService } from '../testing/clock.ts'
import type { TestDatabaseService } from '../testing/database.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestCoreServices } from '../testing/services.ts'
import { buildIndexedNote, type IndexedNote } from './indexed-note.ts'
import type { WikiLinkSuggestionResult } from './queries-shared.ts'

/**
 * Shared helpers for projection-flow tests (`*-flow.test.ts`): projections
 * built from real Markdown, the index services where disk probes see an
 * empty graph, and the end-to-end "selecting this suggestion opens its path"
 * assertion.
 */

export function project(path: string, source: string, mtime: number): IndexedNote {
  return buildIndexedNote(parseNote({ path, source }), {
    fileHash: `hash-${path}`,
    mtime,
    source,
  })
}

/**
 * The index read services and the note services over one test database.
 */
export type FlowIndex = ReturnType<typeof connectIndex>

export function connectIndex(database: TestDatabaseService) {
  // The projections exist only in the index. Disk probes see an empty
  // graph, so the writable resolvers exercise their indexed tiers.
  const notOnDisk = (): never => {
    throw new AppError('notFound', 'not on disk')
  }
  const ipc = createTestIpcBridgeService({
    commands: { list_files: () => [], note_read: notOnDisk, note_read_local: notOnDisk },
  })
  const noteFile = createNoteFileService({
    ipc,
    clock: createTestClockService(),
    fileChanges: createTestFileChangeService(),
  })
  return createTestCoreServices({
    database,
    noteFile,
    graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
  })
}

export function disconnectIndex(database: TestDatabaseService): void {
  database.close()
}

export async function expectSuggestionOpensItsPath(
  index: FlowIndex,
  suggestion: WikiLinkSuggestionResult['suggestions'][number],
): Promise<void> {
  expect(suggestion.path).not.toBeNull()
  const parsed = parseNote({
    path: 'notes/selection-check.md',
    source: `[[${suggestion.insertText}]]`,
  }).wikiLinks
  expect(parsed).toHaveLength(1)
  const target = parsed[0]!.target
  // Both branches mirror the editor's writable click handler, which routes
  // date-shaped targets through the ambiguity-preserving existing-note
  // resolver and everything else through resolve-or-create.
  const resolution =
    normalizeWikiTarget(target).date !== undefined
      ? index.noteLinkResolver.resolveWikiTarget(target, 1)
      : index.noteCreation.resolveOrCreateNoteWithTitle(target, 1)
  await expect(resolution).resolves.toEqual({
    kind: 'resolved',
    path: suggestion.path,
  })
}
