import { describe, expect, it, vi } from 'vitest'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { createTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createLinkedDailyNoteService } from './linked-daily-note-service.ts'

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
  const linkedDailyNotes = createLinkedDailyNoteService({
    noteFile,
    wikiResolver: createWikiResolverService({ database }),
    logger,
  })
  const dailyFiles = (): Record<string, string> => {
    return Object.fromEntries(
      [...noteFile.files()].filter(([path]) => path.startsWith('daily/')).toSorted(),
    )
  }
  return { linkedDailyNotes, noteFile, logger, dailyFiles }
}

describe('ensureDailyNotesLinkedFrom', () => {
  it('creates an empty daily note for each linked day that has none', async () => {
    const { linkedDailyNotes, dailyFiles } = setup()
    await linkedDailyNotes.ensureDailyNotesLinkedFrom(
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
    const { linkedDailyNotes, dailyFiles } = setup({
      indexed: [{ path: 'notes/launch.md', markdown: '# 2026-12-01\n' }],
    })
    await linkedDailyNotes.ensureDailyNotesLinkedFrom('notes/a.md', '[[2026-12-01]]\n', GENERATION)
    expect(dailyFiles()).toEqual({})
  })

  it('keeps a daily note that is on disk and not in the index', async () => {
    const { linkedDailyNotes, dailyFiles, logger } = setup({ files: { [DAY]: 'kept\n' } })
    await linkedDailyNotes.ensureDailyNotesLinkedFrom('notes/a.md', '[[2026-12-01]]\n', GENERATION)
    expect(dailyFiles()).toEqual({ [DAY]: 'kept\n' })
    expect(logger.getErrors()).toEqual([])
  })

  it('creates no note for a link that names no day of another note', async () => {
    const { linkedDailyNotes, dailyFiles } = setup()
    const source = '[[2026-02-31]] [[Project]]\n\n```\n[[2026-12-02]]\n```\n'
    await linkedDailyNotes.ensureDailyNotesLinkedFrom('notes/a.md', source, GENERATION)
    await linkedDailyNotes.ensureDailyNotesLinkedFrom(DAY, '[[2026-12-01]]\n', GENERATION)
    await linkedDailyNotes.ensureDailyNotesLinkedFrom(
      'templates/week.md',
      '[[2026-12-01]]\n',
      GENERATION,
    )
    expect(dailyFiles()).toEqual({})
  })

  it('logs a failure and resolves', async () => {
    const { linkedDailyNotes, noteFile, logger } = setup()
    vi.spyOn(noteFile, 'create').mockRejectedValue(new Error('disk full'))
    await expect(
      linkedDailyNotes.ensureDailyNotesLinkedFrom('notes/a.md', '[[2026-12-01]]\n', GENERATION),
    ).resolves.toBeUndefined()
    expect(logger.getErrors()).toHaveLength(1)
  })
})

describe('ensureDailyNoteAt', () => {
  const linker: TestNote = { path: 'notes/a.md', markdown: '# A\n\n[[2026-12-01]]\n' }

  it('creates the daily note of a day that a note links to', async () => {
    const { linkedDailyNotes, dailyFiles } = setup({ indexed: [linker] })
    await linkedDailyNotes.ensureDailyNoteAt(DAY, GENERATION)
    expect(dailyFiles()).toEqual({ [DAY]: '' })
  })

  it('creates no note for a day without links, or a day that another note claims', async () => {
    const unlinked = setup()
    await unlinked.linkedDailyNotes.ensureDailyNoteAt(DAY, GENERATION)
    expect(unlinked.dailyFiles()).toEqual({})

    const claimed = setup({
      indexed: [linker, { path: 'notes/launch.md', markdown: '# 2026-12-01\n' }],
    })
    await claimed.linkedDailyNotes.ensureDailyNoteAt(DAY, GENERATION)
    expect(claimed.dailyFiles()).toEqual({})
  })
})
