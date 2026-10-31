import { describe, expect, it, vi } from 'vitest'
import { createNodeTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createIndexQueryService } from '../indexing/index-query-service.ts'
import { createNotePathService } from '../indexing/note-path-service.ts'
import { createTestNoteMoveService, createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestIndexStoreService } from '../testing/index-store.ts'
import { createTestProgressPort } from '../testing/ports.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTemplateService, type TemplateInsertTarget } from './template-service.ts'

function setup(options?: { files?: Record<string, string>; indexed?: readonly TestNote[] }) {
  const noteFile = createTestNoteFileService({ files: options?.files ?? {} })
  const database = createNodeTestDatabaseService()
  seedNotes(
    database,
    options?.indexed ??
      Object.entries(options?.files ?? {}).map(([path, markdown]) => ({ path, markdown })),
  )
  const progress = createTestProgressPort()
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  const indexStore = createTestIndexStoreService()
  const moveIndexed = indexStore.moveIndexed.bind(indexStore)
  // The native command moves the file along with its rows.
  vi.spyOn(indexStore, 'moveIndexed').mockImplementation(async (from, to, fileGeneration) => {
    await moveIndexed(from, to, fileGeneration)
    const contents = noteFile.files().get(from)
    if (contents !== undefined) {
      noteFile.set(to, contents)
      await noteFile.delete(from, fileGeneration)
    }
  })
  const noteMove = createTestNoteMoveService({
    indexStore,
    openDocuments,
  })
  const graph = createTestGraphSessionService({ graph: { generation: 7 } })
  const templates = createTemplateService({
    noteFile,
    indexQuery: createIndexQueryService({ database }),
    notePath: createNotePathService({ database, noteFile }),
    noteMove,
    openDocuments,
    progress,
    graphSession: graph,
  })
  return { templates, noteFile, database, progress, openDocuments, noteMove, graph }
}

function fakeEditor(): { inserted: string[]; focused: number } & TemplateInsertTarget {
  const editor = {
    inserted: [] as string[],
    focused: 0,
    insertMarkdown(markdown: string) {
      editor.inserted.push(markdown)
    },
    focus() {
      editor.focused += 1
    },
  }
  return editor
}

describe('templateBody', () => {
  it('strips frontmatter — template metadata is never inserted', async () => {
    const { templates } = setup({
      files: { 'templates/journal.md': '---\nprivate: true\n---\n# Journal\n\nMood:\n' },
    })
    await expect(templates.templateBody('templates/journal.md')).resolves.toBe(
      '# Journal\n\nMood:\n',
    )
  })

  it('returns a frontmatter-less template verbatim', async () => {
    const { templates } = setup({
      files: { 'templates/person.md': '# Person\n\n- Company:\n' },
    })
    await expect(templates.templateBody('templates/person.md')).resolves.toBe(
      '# Person\n\n- Company:\n',
    )
  })
})

describe('insertTemplate', () => {
  it('inserts the body at the cursor and refocuses the editor', async () => {
    const { templates, progress } = setup({
      files: { 'templates/journal.md': '# Journal\n\nMood:\n' },
    })
    const editor = fakeEditor()
    await templates.insertTemplate('templates/journal.md', editor)
    expect(editor.inserted).toEqual(['# Journal\n\nMood:\n'])
    expect(editor.focused).toBe(1)
    expect(progress.getAll()).toEqual([])
  })

  it('fails loud when there is no editor to insert into', async () => {
    const { templates, progress } = setup()
    await templates.insertTemplate('templates/journal.md', null)
    expect(progress.snapshot()).toMatchObject([
      { label: 'Inserting template', status: 'failed', message: 'No open note to insert into' },
    ])
  })

  it('surfaces a failed read as a failed operation, never a silent nothing', async () => {
    const { templates, progress } = setup()
    const editor = fakeEditor()
    await templates.insertTemplate('templates/journal.md', editor)
    expect(editor.inserted).toEqual([])
    expect(progress.snapshot()).toMatchObject([{ label: 'Inserting template', status: 'failed' }])
  })
})

describe('slashItems', () => {
  const files = {
    'templates/person.md': '# Person\n\n- Company:\n',
    'templates/journal.md': '# Journal\n\nMood:\n',
    'notes/a.md': '# A\n',
  }

  it('lists every template A→Z under the shared "template" keyword', async () => {
    const { templates } = setup({ files })
    const items = await templates.slashItems(() => null)
    expect(items.map(({ id, label, keywords }) => ({ id, label, keywords }))).toEqual([
      // The shared "template" keyword is the v1 `/template` affordance.
      { id: 'templates/journal.md', label: 'Journal', keywords: ['template'] },
      { id: 'templates/person.md', label: 'Person', keywords: ['template'] },
    ])
  })

  it('inserts the selected template through the shared flow', async () => {
    const { templates } = setup({ files })
    const editor = fakeEditor()
    const items = await templates.slashItems(() => editor)
    items[0]!.onSelect()
    await expect.poll(() => editor.inserted).toEqual(['# Journal\n\nMood:\n'])
  })

  it('resolves the editor at select time, not capture time', async () => {
    const { templates, progress } = setup({ files })
    let editor: TemplateInsertTarget | null = fakeEditor()
    const items = await templates.slashItems(() => editor)
    // The pane unmounted between the menu opening and the select.
    editor = null
    items[0]!.onSelect()
    await expect
      .poll(() => progress.snapshot())
      .toMatchObject([{ label: 'Inserting template', message: 'No open note to insert into' }])
  })
})

describe('createTemplate', () => {
  it('names the template via frontmatter so insertion never injects the name', async () => {
    const { templates, noteFile } = setup()
    await expect(templates.createTemplate('  Daily Review ')).resolves.toBe(
      'templates/daily-review.md',
    )
    expect(noteFile.writes()).toEqual([
      {
        path: 'templates/daily-review.md',
        contents: '---\ntitle: Daily Review\n---\n\n',
        generation: 7,
      },
    ])
  })

  it('picks a collision-free path', async () => {
    const { templates } = setup({ files: { 'templates/daily-review.md': 'Mood:\n' } })
    await expect(templates.createTemplate('Daily Review')).resolves.toBe(
      'templates/daily-review-2.md',
    )
  })

  it('rejects and writes nothing when no graph is open', async () => {
    const { templates, noteFile, graph } = setup()
    graph.setGraph(null)

    await expect(templates.createTemplate('Daily Review')).rejects.toThrow('No graph is open.')
    expect(noteFile.writes()).toEqual([])
  })
})

describe('renameTemplate', () => {
  it('moves the file and rewrites the H1 the display name derives from', async () => {
    const { templates, noteFile, noteMove } = setup({
      files: { 'templates/journal.md': '# Journal\n\nMood:\n' },
    })

    await expect(templates.renameTemplate('templates/journal.md', 'Weekly Journal')).resolves.toBe(
      'templates/weekly-journal.md',
    )
    expect(noteMove.moved()).toEqual([['templates/journal.md', 'templates/weekly-journal.md']])
    // The retitle reads and writes the moved file.
    expect(noteFile.writes()).toEqual([
      {
        path: 'templates/weekly-journal.md',
        contents: '# Weekly Journal\n\nMood:\n',
        generation: 7,
      },
    ])
    expect([...noteFile.files().keys()]).toEqual(['templates/weekly-journal.md'])
  })

  it('a no-op rename neither moves nor writes (its own path counts as free)', async () => {
    const { templates, noteFile, noteMove } = setup({
      files: { 'templates/journal.md': '# Journal\n\nMood:\n' },
    })

    await expect(templates.renameTemplate('templates/journal.md', 'Journal')).resolves.toBe(
      'templates/journal.md',
    )
    expect(noteMove.moved()).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('flushes the open session before a rename that skips the move', async () => {
    const { templates, openDocuments } = setup({
      files: { 'templates/journal.md': '# Journal\n\nMood:\n' },
    })
    const session = createTestNoteSession({
      path: 'templates/journal.md',
      content: '# Journal\n\nMood:\n',
    })
    openDocuments.register({ session })

    await templates.renameTemplate('templates/journal.md', 'Journal')
    expect(session.getCalls('flush')).toHaveLength(1)
  })

  it('rewrites the H1 preserving frontmatter and the rest of the body', async () => {
    const { templates, noteFile } = setup({
      files: { 'templates/journal.md': '---\nprivate: true\n---\n# Journal\n\n- Mood:\n' },
    })

    await templates.renameTemplate('templates/journal.md', 'Log')
    expect(noteFile.files().get('templates/log.md')).toBe(
      '---\nprivate: true\n---\n# Log\n\n- Mood:\n',
    )
  })

  it('updates a frontmatter title when that is what names the template', async () => {
    const { templates, noteFile } = setup({
      files: { 'templates/journal.md': '---\ntitle: Journal\n---\nMood:\n' },
    })

    await templates.renameTemplate('templates/journal.md', 'Log')
    const written = noteFile.files().get('templates/log.md')
    expect(written).toContain('title: Log')
    expect(written).toContain('Mood:\n')
  })

  it('leaves an untitled (filename-named) template body untouched', async () => {
    const { templates, noteFile, noteMove } = setup({
      files: { 'templates/journal.md': 'Mood:\n' },
    })

    await templates.renameTemplate('templates/journal.md', 'Log')
    expect(noteMove.moved()).toEqual([['templates/journal.md', 'templates/log.md']])
    expect(noteFile.writes()).toEqual([])
  })
})
