import { describe, expect, it } from 'vitest'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import {
  createNodeTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService, type TestNoteFileService } from '../testing/graph.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestProgressPort, type TestProgressPort } from '../testing/ports.ts'
import {
  createSuggestedBacklinkService,
  type SuggestedBacklinkService,
} from './suggested-backlink-service.ts'

function setup(notes: readonly TestNote[]): {
  service: SuggestedBacklinkService
  database: TestDatabaseService
  files: TestNoteFileService
  progress: TestProgressPort
} {
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  const files = createTestNoteFileService({
    files: Object.fromEntries(notes.map((note) => [note.path, note.markdown])),
  })
  const graphSession = createTestGraphSessionService({ graph: { generation: 1 } })
  const progress = createTestProgressPort()
  return {
    service: createSuggestedBacklinkService({
      database,
      noteDocuments: createNoteDocumentService({
        openDocuments: createOpenDocumentsService({ fileChanges: createTestFileChangeService() }),
        noteFile: files,
        graphSession,
      }),
      progress,
      graphSession,
    }),
    database,
    files,
    progress,
  }
}

describe('getSuggestedBacklinks', () => {
  it('finds plain-text mentions of the title and aliases, newest first', async () => {
    const { service } = setup([
      { path: 'notes/sarah.md', markdown: '---\naliases: [Sal]\n---\n# Sarah Jones\n' },
      { path: 'notes/older.md', markdown: 'Lunch with sarah jones.\n', mtime: 1_000 },
      { path: 'daily/2026-07-01.md', markdown: '- called Sal\n- other\n', mtime: 5_000 },
      { path: 'notes/unrelated.md', markdown: 'Nothing here.\n', mtime: 9_000 },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/sarah.md')

    expect(mentions.map(({ sourcePath, line }) => ({ sourcePath, line }))).toEqual([
      { sourcePath: 'daily/2026-07-01.md', line: 'called Sal' },
      { sourcePath: 'notes/older.md', line: 'Lunch with sarah jones.' },
    ])
  })

  it('leaves out sources that already link to the note, and mentions inside code', async () => {
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/linked.md', markdown: 'Met [[Acme]]. Acme again.\n' },
      { path: 'notes/code.md', markdown: 'Run `acme --help`.\n' },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/acme.md')

    expect(mentions).toEqual([])
  })

  it('collapses mentions on one line into one plain-text entry anchored at the first', async () => {
    const content = 'Acme met **Acme**.\n\nLater, [[Other]] and Acme.\n'
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/source.md', markdown: content },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/acme.md')

    expect(mentions.map(({ line, mention }) => ({ line, from: mention.from }))).toEqual([
      { line: 'Acme met Acme.', from: 0 },
      { line: 'Later, Other and Acme.', from: content.lastIndexOf('Acme') },
    ])
  })

  it('offers nothing for daily notes, short titles, or names another note also claims', async () => {
    const { service } = setup([
      { path: 'daily/2026-07-01.md', markdown: 'today\n' },
      { path: 'notes/ai.md', markdown: '# AI\n' },
      { path: 'notes/mercury-planet.md', markdown: '# Mercury\n' },
      { path: 'notes/mercury-element.md', markdown: '# Mercury\n' },
      { path: 'notes/source.md', markdown: 'AI and Mercury on 2026-07-01.\n' },
    ])

    for (const path of ['daily/2026-07-01.md', 'notes/ai.md', 'notes/mercury-planet.md']) {
      expect(await service.getSuggestedBacklinks(path)).toEqual([])
    }
  })

  it('offers no name that a plain link would read as something else', async () => {
    const { service } = setup([
      { path: 'notes/c-guide.md', markdown: '# C# Guide\n' },
      { path: 'notes/source.md', markdown: 'Read the C# Guide today.\n' },
    ])

    expect(await service.getSuggestedBacklinks('notes/c-guide.md')).toEqual([])
  })

  function notes(count: number, markdown: string, firstMtime: number, prefix: string): TestNote[] {
    return Array.from({ length: count }, (_, index) => ({
      path: `notes/${prefix}-${String(index).padStart(3, '0')}.md`,
      markdown,
      mtime: firstMtime + index,
    }))
  }

  it('returns the 30 newest notes that really mention the name', async () => {
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      ...notes(32, 'Met Acme.\n', 1_000, 'real'),
    ])

    const mentions = await service.getSuggestedBacklinks('notes/acme.md')

    expect(mentions).toHaveLength(30)
    expect(mentions.map((mention) => mention.sourcePath)).not.toContain('notes/real-000.md')
    expect(mentions.map((mention) => mention.sourcePath)).not.toContain('notes/real-001.md')
  })

  it('reads past newer candidates whose only hits are not mentions', async () => {
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/older.md', markdown: 'Met Acme.\n', mtime: 1 },
      ...notes(40, 'Run `acme`.\n', 1_000, 'code'),
    ])

    const mentions = await service.getSuggestedBacklinks('notes/acme.md')

    expect(mentions.map((mention) => mention.sourcePath)).toEqual(['notes/older.md'])
  })

  it('stops after reading 100 candidates', async () => {
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/older.md', markdown: 'Met Acme.\n', mtime: 1 },
      ...notes(100, 'Run `acme`.\n', 1_000, 'code'),
    ])

    expect(await service.getSuggestedBacklinks('notes/acme.md')).toEqual([])
  })

  it('shows a nested list item without its markers', async () => {
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/source.md', markdown: '- Projects\n    - Call **Acme** back\n' },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/acme.md')

    expect(mentions.map((mention) => mention.line)).toEqual(['Call Acme back'])
  })

  it('finds unsegmented names whose letters SQLite cannot lowercase', async () => {
    const { service } = setup([
      { path: 'notes/abc.md', markdown: '# ＡＢＣ商事\n' },
      { path: 'notes/memo.md', markdown: 'ＡＢＣ商事に電話した。\n' },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/abc.md')

    expect(mentions.map((mention) => mention.line)).toEqual(['ＡＢＣ商事に電話した。'])
  })

  it('shows table rows and lines of multi-line constructs as plain text', async () => {
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/table.md', markdown: '| Co | n |\n|---|---|\n| Acme | 3 |\n', mtime: 2 },
      { path: 'notes/bold.md', markdown: '**Kickoff with\nAcme team**\n', mtime: 1 },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/acme.md')

    expect(mentions.map((mention) => mention.line)).toEqual(['Acme 3', 'Acme team'])
  })

  it('flattens wiki links in an excerpt the way note previews do', async () => {
    const { service } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/lunch.md', markdown: 'Lunch with [[Bob Jones|Bob]] and Acme.\n' },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/acme.md')

    expect(mentions.map((mention) => mention.line)).toEqual(['Lunch with Bob Jones Bob and Acme.'])
  })

  it('leaves out a source whose current text links, before the index catches up', async () => {
    const { service, files } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/source.md', markdown: 'Met Acme.\nAlso Acme.\n' },
    ])
    files.set('notes/source.md', 'Met [[Acme]].\nAlso Acme.\n')

    expect(await service.getSuggestedBacklinks('notes/acme.md')).toEqual([])
  })

  it('finds names in unsegmented scripts, which the full-text index cannot', async () => {
    const { service } = setup([
      { path: 'notes/tanaka.md', markdown: '# 田中\n' },
      { path: 'notes/diary.md', markdown: '今日は田中さんと会った。\n' },
    ])

    const mentions = await service.getSuggestedBacklinks('notes/tanaka.md')

    expect(mentions.map((mention) => mention.line)).toEqual(['今日は田中さんと会った。'])
  })
})

describe('linkMention', () => {
  it('rewrites the mention as a wiki link that keeps its spelling', async () => {
    const { service, files } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/source.md', markdown: 'Talked to acme today.\n' },
    ])
    const [entry] = await service.getSuggestedBacklinks('notes/acme.md')
    if (entry === undefined) {
      throw new Error('expected a mention')
    }

    await service.linkMention('notes/acme.md', entry.sourcePath, entry.mention)

    expect(files.files().get('notes/source.md')).toBe('Talked to [[acme]] today.\n')
  })

  it('refuses and reports when the note changed under the mention', async () => {
    const { service, files, progress } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/source.md', markdown: 'Talked to Acme today.\n' },
    ])
    const [entry] = await service.getSuggestedBacklinks('notes/acme.md')
    if (entry === undefined) {
      throw new Error('expected a mention')
    }
    files.set('notes/source.md', 'We all talked to Acme today.\n')

    await expect(
      service.linkMention('notes/acme.md', entry.sourcePath, entry.mention),
    ).rejects.toThrow('The note has changed')

    expect(files.files().get('notes/source.md')).toBe('We all talked to Acme today.\n')
    expect(progress.findByLabel('Linking mention')).toBeDefined()
  })

  it('says the name no longer links when the target was renamed since the list loaded', async () => {
    const { service, database, files, progress } = setup([
      { path: 'notes/acme.md', markdown: '# Acme\n' },
      { path: 'notes/source.md', markdown: 'Talked to Acme today.\n' },
    ])
    const [entry] = await service.getSuggestedBacklinks('notes/acme.md')
    if (entry === undefined) {
      throw new Error('expected a mention')
    }
    seedNotes(database, [{ path: 'notes/acme.md', markdown: '# Acme Corp\n' }])

    await expect(
      service.linkMention('notes/acme.md', entry.sourcePath, entry.mention),
    ).rejects.toThrow('This note can no longer be linked by that name.')

    expect(files.files().get('notes/source.md')).toBe('Talked to Acme today.\n')
    expect(progress.findByLabel('Linking mention')).toBeDefined()
  })
})
