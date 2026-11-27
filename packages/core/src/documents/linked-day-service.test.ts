import { noop } from '@ocavue/utils'
import { describe, expect, it, vi } from 'vitest'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestNoteSessionService } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteCreationService, createTestNoteFileService } from '../testing/graph.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createLinkedDayService } from './linked-day-service.ts'
import { createNoteDocumentService } from './note-document-service.ts'
import { createNoteSessionService } from './note-session-service.ts'

const GENERATION = 1
const DAY = 'daily/2026-12-01.md'

interface Graph {
  /**
   * Notes projected into the index.
   */
  readonly indexed?: readonly TestNote[]
  /**
   * Files on disk.
   */
  readonly files?: Record<string, string>
}

function setup({ indexed = [], files = {} }: Graph = {}) {
  const database = createTestDatabaseService()
  seedNotes(database, indexed)
  const noteFile = createTestNoteFileService({ files, generation: GENERATION })
  const logger = createTestLoggerService()
  const clock = createTestClockService()
  const graphSession = createTestGraphSessionService({ graph: { generation: GENERATION } })
  const linkedDays = createLinkedDayService({
    noteFile,
    wikiResolver: createWikiResolverService({ database }),
    logger,
  })
  const noteSessions = createNoteSessionService({
    noteFile,
    clock,
    logger,
    graphSession,
    fileChanges: createTestFileChangeService(),
    noteCreation: createTestNoteCreationService(),
    linkedDays,
    createCoordinator: () => ({
      content: noop,
      settle: noop,
      settled: noop,
      retarget: noop,
      dispose: noop,
    }),
  })
  const noteDocuments = createNoteDocumentService({
    noteSessions: createTestNoteSessionService(),
    noteFile,
    graphSession,
    indexLifecycle: createTestIndexLifecycleService(),
    linkedDays,
    logger,
  })
  const dailyFiles = (): Record<string, string> => {
    return Object.fromEntries(
      [...noteFile.files()].filter(([path]) => path.startsWith('daily/')).toSorted(),
    )
  }
  return { linkedDays, noteSessions, noteDocuments, noteFile, clock, logger, dailyFiles }
}

describe('ensureLinkedDays', () => {
  it('creates an empty daily note for each linked day that has none', async () => {
    const { linkedDays, dailyFiles } = setup()
    await linkedDays.ensureLinkedDays(
      'notes/a.md',
      '# A\n\n- [ ] call [[2026-12-01]]\n- [[2026-12-02|Wed]] and [[2026-12-03#Plan]]\n- again [[2026-12-01]]\n',
      GENERATION,
    )
    expect(dailyFiles()).toEqual({
      'daily/2026-12-01.md': '',
      'daily/2026-12-02.md': '',
      'daily/2026-12-03.md': '',
    })
  })

  it('creates no note for a day that another note claims', async () => {
    const { linkedDays, dailyFiles } = setup({
      indexed: [{ path: 'notes/launch.md', markdown: '# 2026-12-01\n' }],
    })
    await linkedDays.ensureLinkedDays('notes/a.md', '[[2026-12-01]]\n', GENERATION)
    expect(dailyFiles()).toEqual({})
  })

  it('keeps a daily note that is on disk and not in the index', async () => {
    const { linkedDays, dailyFiles, logger } = setup({ files: { [DAY]: 'kept\n' } })
    await linkedDays.ensureLinkedDays('notes/a.md', '[[2026-12-01]]\n', GENERATION)
    expect(dailyFiles()).toEqual({ [DAY]: 'kept\n' })
    expect(logger.getErrors()).toEqual([])
  })

  it('creates no note for a link that names no day of another note', async () => {
    const { linkedDays, dailyFiles } = setup()
    const source = '[[2026-02-31]] [[Project]]\n\n```\n[[2026-12-02]]\n```\n'
    await linkedDays.ensureLinkedDays('notes/a.md', source, GENERATION)
    await linkedDays.ensureLinkedDays(DAY, '[[2026-12-01]]\n', GENERATION)
    await linkedDays.ensureLinkedDays('templates/week.md', '[[2026-12-01]]\n', GENERATION)
    expect(dailyFiles()).toEqual({})
  })

  it('logs a failure and resolves', async () => {
    const { linkedDays, noteFile, logger } = setup()
    vi.spyOn(noteFile, 'create').mockRejectedValue(new Error('disk full'))
    await expect(
      linkedDays.ensureLinkedDays('notes/a.md', '[[2026-12-01]]\n', GENERATION),
    ).resolves.toBeUndefined()
    expect(logger.getErrors()).toHaveLength(1)
  })
})

describe('ensureLinkedDay', () => {
  const linker: TestNote = { path: 'notes/a.md', markdown: '# A\n\n[[2026-12-01]]\n' }

  it('creates the daily note of a day that a note links to', async () => {
    const { linkedDays, dailyFiles } = setup({ indexed: [linker] })
    await linkedDays.ensureLinkedDay(DAY, GENERATION)
    expect(dailyFiles()).toEqual({ [DAY]: '' })
  })

  it('creates no note for a day without links, or a day that another note claims', async () => {
    const unlinked = setup()
    await unlinked.linkedDays.ensureLinkedDay(DAY, GENERATION)
    expect(unlinked.dailyFiles()).toEqual({})

    const claimed = setup({
      indexed: [linker, { path: 'notes/launch.md', markdown: '# 2026-12-01\n' }],
    })
    await claimed.linkedDays.ensureLinkedDay(DAY, GENERATION)
    expect(claimed.dailyFiles()).toEqual({})
  })
})

describe('note writes', () => {
  it('creates the linked day when a session saves', async () => {
    const { noteSessions, clock, dailyFiles } = setup({ files: { 'notes/a.md': '# A\n' } })
    const session = noteSessions.sessionFor('notes/a.md')
    session.subscribe(noop)
    await clock.advance(50)

    session.editorChanged('# A\n\n[[2026-12-01]]\n')
    await session.flush()
    await vi.waitFor(() => {
      expect(dailyFiles()).toEqual({ [DAY]: '' })
    })
  })

  it('creates the linked day when a source edit lands on disk', async () => {
    const { noteDocuments, dailyFiles } = setup({ files: { 'notes/a.md': '# A\n' } })
    await noteDocuments.commitSourceEdit(
      'notes/a.md',
      (source) => `${source}\n- [ ] call [[2026-12-01]]\n`,
      { generation: GENERATION },
    )
    await vi.waitFor(() => {
      expect(dailyFiles()).toEqual({ [DAY]: '' })
    })
  })
})

describe('opening a day', () => {
  it('creates the daily note of a missing day that a note links to', async () => {
    const { noteSessions, clock, dailyFiles } = setup({
      indexed: [{ path: 'notes/a.md', markdown: '# A\n\n[[2026-12-01]]\n' }],
    })
    noteSessions.sessionFor(DAY).subscribe(noop)
    noteSessions.sessionFor('daily/2026-12-02.md').subscribe(noop)
    await clock.advance(50)
    await vi.waitFor(() => {
      expect(dailyFiles()).toEqual({ [DAY]: '' })
    })
  })
})
