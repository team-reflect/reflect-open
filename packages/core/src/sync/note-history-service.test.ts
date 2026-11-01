import { describe, expect, it } from 'vitest'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import {
  createTestFileChangeService,
  createTestGitRepositoryService,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestNoteSession,
  createTestPersistenceFlushService,
} from '../testing/index.ts'
import type { NoteRevision } from './git-repository-service.ts'
import { createNoteHistoryService, NOTE_HISTORY_PAGE_SIZE } from './note-history-service.ts'

const PATH = 'notes/atlas.md'
const NOW = '---\nid: 01j\nprivate: true\n---\n# Atlas\n\nnow\n'
const THEN = '---\nid: 01j\n---\n# Atlas\n\nthen\n'
const REVISION: NoteRevision = {
  oid: 'abc',
  path: 'notes/01j.md',
  timeMs: 1_700_000_000_000,
  summary: 'Update Atlas',
}

function setup(options?: { open?: boolean; liveContent?: string }) {
  const files = createTestNoteFileService({ files: { [PATH]: NOW } })
  const graphSession = createTestGraphSessionService(
    options?.open === false ? undefined : { graph: { generation: 4 } },
  )
  // HEAD holds whatever the last git-sync flush committed.
  let head = NOW
  const gitRepository = createTestGitRepositoryService({ initialized: true })
  gitRepository.onNoteRevision((revision) => (revision.oid === 'HEAD' ? head : THEN))
  let commit = async (): Promise<void> => {
    head = await files.read(PATH, 4)
  }
  const persistenceFlush = createTestPersistenceFlushService()
  persistenceFlush.registerFlusher('git-sync', () => commit())
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  const session =
    options?.liveContent === undefined
      ? null
      : createTestNoteSession({ path: PATH, content: options.liveContent })
  if (session !== null) {
    openDocuments.register({ session })
  }
  const service = createNoteHistoryService({
    gitRepository,
    noteDocuments: createNoteDocumentService({ openDocuments, noteFile: files, graphSession }),
    persistenceFlush,
    graphSession,
  })
  return {
    service,
    files,
    gitRepository,
    session,
    setCommit: (fn: () => Promise<void>) => {
      commit = fn
    },
    setHead: (text: string) => {
      head = text
    },
  }
}

describe('createNoteHistoryService', () => {
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

  it('restores an open note through its live session', async () => {
    const { service, session, setHead } = setup({ liveContent: NOW })
    setHead(NOW)

    await service.restore(PATH, REVISION)

    expect(session?.content()).toBe('---\nid: 01j\nprivate: true\n---\n# Atlas\n\nthen\n')
  })

  it('waits for the pre-restore commit before it writes', async () => {
    const { service, files, setCommit } = setup()
    let finishCommit = (): void => {}
    setCommit(() => {
      return new Promise<void>((resolve) => {
        finishCommit = resolve
      })
    })

    const restoring = service.restore(PATH, REVISION)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(files.read(PATH, 4)).resolves.toBe(NOW)

    finishCommit()
    await restoring
    await expect(files.read(PATH, 4)).resolves.toContain('then')
  })

  it('restores nothing when the current text did not reach history', async () => {
    const { service, files, setCommit, setHead } = setup()
    setHead('---\nid: 01j\n---\n# Atlas\n\nolder\n')
    setCommit(() => Promise.resolve())

    await expect(service.restore(PATH, REVISION)).rejects.toMatchObject({ kind: 'io' })
    await expect(files.read(PATH, 4)).resolves.toBe(NOW)
  })
})
