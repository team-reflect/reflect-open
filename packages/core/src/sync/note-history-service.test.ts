import { describe, expect, it } from 'vitest'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import {
  createTestFileChangeService,
  createTestGitRepositoryService,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestPersistenceFlushService,
} from '../testing/index.ts'
import type { NoteRevision } from './git-repository-service.ts'
import { createNoteHistoryService, NOTE_HISTORY_PAGE_SIZE } from './note-history-service.ts'

const PATH = 'notes/atlas.md'
const REVISION: NoteRevision = {
  oid: 'abc',
  path: 'notes/01j.md',
  timeMs: 1_700_000_000_000,
  summary: 'Update Atlas',
}

function setup(options?: { source?: string; open?: boolean; initialized?: boolean }) {
  const files = createTestNoteFileService({
    files: { [PATH]: options?.source ?? '---\nid: 01j\nprivate: true\n---\n# Atlas\n\nnow\n' },
  })
  const graphSession = createTestGraphSessionService(
    options?.open === false ? undefined : { graph: { generation: 4 } },
  )
  const gitRepository = createTestGitRepositoryService({
    initialized: options?.initialized ?? true,
  })
  const order: string[] = []
  gitRepository.onNoteRevision(() => '---\nid: 01j\n---\n# Atlas\n\nthen\n')
  const persistenceFlush = createTestPersistenceFlushService()
  persistenceFlush.registerFlusher('git-sync', () => {
    order.push('commit')
    return Promise.resolve()
  })
  const service = createNoteHistoryService({
    gitRepository,
    noteDocuments: createNoteDocumentService({
      openDocuments: createOpenDocumentsService({ fileChanges: createTestFileChangeService() }),
      noteFile: files,
      graphSession,
    }),
    persistenceFlush,
    graphSession,
  })
  return { service, files, gitRepository, order }
}

describe('createNoteHistoryService', () => {
  it('is available only for a graph with a repository', async () => {
    await expect(setup().service.isAvailable()).resolves.toBe(true)
    await expect(setup({ initialized: false }).service.isAvailable()).resolves.toBe(false)
    await expect(setup({ open: false }).service.isAvailable()).resolves.toBe(false)
  })

  it('pages revisions at the open generation', async () => {
    const { service, gitRepository } = setup()

    await service.revisions(PATH, 'cursor')

    expect(gitRepository.calls()).toContainEqual({
      method: 'noteHistory',
      args: [PATH, 'cursor', NOTE_HISTORY_PAGE_SIZE, 4],
    })
  })

  it('refuses to read history with no graph open', async () => {
    await expect(setup({ open: false }).service.revisions(PATH, null)).rejects.toMatchObject({
      kind: 'noGraph',
    })
  })

  it('restores the revision body under the current frontmatter', async () => {
    const { service, files } = setup()

    await service.restore(PATH, REVISION)

    await expect(files.read(PATH, 4)).resolves.toBe(
      '---\nid: 01j\nprivate: true\n---\n# Atlas\n\nthen\n',
    )
  })

  it('commits pending edits before it restores', async () => {
    const { service, order, files } = setup()
    const write = files.write.bind(files)
    files.write = async (...args) => {
      order.push('write')
      return await write(...args)
    }

    await service.restore(PATH, REVISION)

    expect(order).toEqual(['commit', 'write'])
  })
})
