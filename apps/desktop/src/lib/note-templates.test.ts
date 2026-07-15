import { beforeEach, describe, expect, it, vi } from 'vitest'

const readNote = vi.hoisted(() => vi.fn())
const createNoteIfAbsent = vi.hoisted(() =>
  vi.fn<
    (
      path: string,
      content: string,
      generation: number,
    ) => Promise<{ kind: 'created'; modifiedMs: number | null } | { kind: 'collision' }>
  >(async () => ({ kind: 'created', modifiedMs: null })),
)
const writeNoteIfUnchanged = vi.hoisted(() =>
  vi.fn<
    (
      path: string,
      expected: string | null,
      content: string,
      generation: number,
    ) => Promise<{ kind: 'written'; modifiedMs: number | null } | { kind: 'changed' }>
  >(async () => ({ kind: 'written', modifiedMs: null })),
)
const templateSlugPathForTitle = vi.hoisted(() => vi.fn())
const moveNoteCarryingSession = vi.hoisted(() => vi.fn(async () => undefined))
const openSession = vi.hoisted(() => vi.fn(() => null))
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: vi.fn(), fail: operationFail })),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  createNoteIfAbsent,
  readNote,
  writeNoteIfUnchanged,
  templateSlugPathForTitle,
}))
vi.mock('@/editor/move-note', () => ({ moveNoteCarryingSession }))
vi.mock('@/editor/open-documents', () => ({ openSession }))
vi.mock('@/lib/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operations')>()),
  startOperation,
}))

const { createTemplate, insertTemplate, renameTemplate, templateBody } = await import(
  './note-templates'
)

beforeEach(() => {
  vi.clearAllMocks()
})

function fakeEditor(): { inserted: string[]; focused: number } & Parameters<
  typeof insertTemplate
>[1] {
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
    readNote.mockResolvedValueOnce('---\nprivate: true\n---\n# Journal\n\nMood:\n')
    await expect(templateBody('templates/journal.md')).resolves.toBe('# Journal\n\nMood:\n')
  })

  it('returns a frontmatter-less template verbatim', async () => {
    readNote.mockResolvedValueOnce('# Person\n\n- Company:\n')
    await expect(templateBody('templates/person.md')).resolves.toBe('# Person\n\n- Company:\n')
  })
})

describe('insertTemplate', () => {
  it('inserts the body at the cursor and refocuses the editor', async () => {
    readNote.mockResolvedValueOnce('# Journal\n\nMood:\n')
    const editor = fakeEditor()
    await insertTemplate('templates/journal.md', editor)
    expect(editor.inserted).toEqual(['# Journal\n\nMood:\n'])
    expect(editor.focused).toBe(1)
    expect(startOperation).not.toHaveBeenCalled()
  })

  it('fails loud when there is no editor to insert into', async () => {
    await insertTemplate('templates/journal.md', null)
    expect(startOperation).toHaveBeenCalledWith('Inserting template')
    expect(operationFail).toHaveBeenCalledWith('No open note to insert into')
  })

  it('surfaces a failed read as a failed operation, never a silent nothing', async () => {
    readNote.mockRejectedValueOnce(new Error('gone'))
    await insertTemplate('templates/journal.md', fakeEditor())
    expect(startOperation).toHaveBeenCalledWith('Inserting template')
    expect(operationFail).toHaveBeenCalledWith('gone')
  })
})

describe('createTemplate', () => {
  it('names the template via frontmatter so insertion never injects the name', async () => {
    await expect(createTemplate('  Daily Review ', 7)).resolves.toBe('templates/daily-review.md')
    expect(createNoteIfAbsent).toHaveBeenCalledWith(
      'templates/daily-review.md',
      '---\ntitle: Daily Review\n---\n',
      7,
    )
  })

  it('preserves a concurrently created path and atomically claims the next suffix', async () => {
    createNoteIfAbsent
      .mockResolvedValueOnce({ kind: 'collision' })
      .mockResolvedValueOnce({ kind: 'created', modifiedMs: 42 })

    await expect(createTemplate('Daily Review', 7)).resolves.toBe(
      'templates/daily-review-2.md',
    )
    expect(createNoteIfAbsent).toHaveBeenNthCalledWith(
      1,
      'templates/daily-review.md',
      '---\ntitle: Daily Review\n---\n',
      7,
    )
    expect(createNoteIfAbsent).toHaveBeenNthCalledWith(
      2,
      'templates/daily-review-2.md',
      '---\ntitle: Daily Review\n---\n',
      7,
    )
  })
})

describe('renameTemplate', () => {
  it('moves the file and rewrites the H1 the display name derives from', async () => {
    templateSlugPathForTitle.mockResolvedValueOnce('templates/weekly-journal.md')
    readNote.mockResolvedValueOnce('# Journal\n\nMood:\n')

    await expect(renameTemplate('templates/journal.md', 'Weekly Journal', 7)).resolves.toBe(
      'templates/weekly-journal.md',
    )
    expect(moveNoteCarryingSession).toHaveBeenCalledWith(
      'templates/journal.md',
      'templates/weekly-journal.md',
      7,
    )
    // The retitle reads and writes the moved file.
    expect(readNote).toHaveBeenCalledWith('templates/weekly-journal.md')
    expect(writeNoteIfUnchanged).toHaveBeenCalledWith(
      'templates/weekly-journal.md',
      '# Journal\n\nMood:\n',
      '# Weekly Journal\n\nMood:\n',
      7,
    )
  })

  it('a no-op rename neither moves nor writes (its own path counts as free)', async () => {
    templateSlugPathForTitle.mockResolvedValueOnce('templates/journal.md')
    readNote.mockResolvedValueOnce('# Journal\n\nMood:\n')

    await expect(renameTemplate('templates/journal.md', 'Journal', 7)).resolves.toBe(
      'templates/journal.md',
    )
    expect(moveNoteCarryingSession).not.toHaveBeenCalled()
    expect(writeNoteIfUnchanged).not.toHaveBeenCalled()
  })

  it('rewrites the H1 preserving frontmatter and the rest of the body', async () => {
    templateSlugPathForTitle.mockResolvedValueOnce('templates/journal.md')
    readNote.mockResolvedValueOnce('---\nprivate: true\n---\n# Journal\n\n- Mood:\n')

    await renameTemplate('templates/journal.md', 'Log', 7)
    expect(writeNoteIfUnchanged).toHaveBeenCalledWith(
      'templates/journal.md',
      '---\nprivate: true\n---\n# Journal\n\n- Mood:\n',
      '---\nprivate: true\n---\n# Log\n\n- Mood:\n',
      7,
    )
  })

  it('updates a frontmatter title when that is what names the template', async () => {
    templateSlugPathForTitle.mockResolvedValueOnce('templates/journal.md')
    readNote.mockResolvedValueOnce('---\ntitle: Journal\n---\nMood:\n')

    await renameTemplate('templates/journal.md', 'Log', 7)
    const written = writeNoteIfUnchanged.mock.calls[0]![2]
    expect(written).toContain('title: Log')
    expect(written).toContain('Mood:\n')
  })

  it('leaves an untitled (filename-named) template body untouched', async () => {
    templateSlugPathForTitle.mockResolvedValueOnce('templates/log.md')
    readNote.mockResolvedValueOnce('Mood:\n')

    await renameTemplate('templates/journal.md', 'Log', 7)
    expect(moveNoteCarryingSession).toHaveBeenCalledWith(
      'templates/journal.md',
      'templates/log.md',
      7,
    )
    expect(writeNoteIfUnchanged).not.toHaveBeenCalled()
  })

  it('refuses to overwrite a template changed or removed after the read', async () => {
    templateSlugPathForTitle.mockResolvedValueOnce('templates/journal.md')
    readNote.mockResolvedValueOnce('# Journal\n\nMood:\n')
    writeNoteIfUnchanged.mockResolvedValueOnce({ kind: 'changed' })

    await expect(renameTemplate('templates/journal.md', 'Log', 7)).rejects.toThrow(
      'The template changed or was removed before its title update landed.',
    )
  })
})
