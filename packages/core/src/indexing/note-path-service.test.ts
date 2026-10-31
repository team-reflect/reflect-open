import { describe, expect, it, vi } from 'vitest'
import { createNodeTestDatabaseService, seedNotes } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createNotePathService, type NotePathService } from './note-path-service.ts'

function setup(): NotePathService {
  const database = createNodeTestDatabaseService()
  seedNotes(database, [
    { path: 'notes/meeting.md', markdown: '# Meeting\n' },
    { path: 'templates/journal.md', markdown: '# Journal\n' },
  ])
  const noteFile = createTestNoteFileService({
    files: { 'notes/meeting-2.md': '# Meeting\n', 'templates/journal-2.md': '# Journal\n' },
  })
  return createNotePathService({ database, noteFile })
}

const paths = setup()

describe('the default probe', () => {
  it('counts a path as taken when the index has a row or the file is on disk', async () => {
    await expect(paths.slugPathForTitle('notes/01abc.md', 'Meeting')).resolves.toBe(
      'notes/meeting-3.md',
    )
    await expect(paths.availableTemplatePath('journal')).resolves.toBe('templates/journal-3.md')
    await expect(paths.templateSlugPathForTitle('templates/journal.md', 'Journal')).resolves.toBe(
      'templates/journal.md',
    )
  })
})

describe('availableTemplatePath', () => {
  it('probes under templates/ with the same collision suffix', async () => {
    const occupied = new Set(['templates/journal.md'])
    await expect(
      paths.availableTemplatePath('journal', (path) => Promise.resolve(occupied.has(path))),
    ).resolves.toBe('templates/journal-2.md')
  })
})

describe('templateSlugPathForTitle', () => {
  it('returns the template’s own path unchanged when the name already matches', async () => {
    const probe = vi.fn(() => Promise.resolve(true))
    await expect(
      paths.templateSlugPathForTitle('templates/journal.md', 'Journal', probe),
    ).resolves.toBe('templates/journal.md')
    // Its own path is never probed — a no-op rename must not move onto `-2`.
    expect(probe).not.toHaveBeenCalled()
  })

  it('suffixes around occupied candidates', async () => {
    const occupied = new Set(['templates/log.md'])
    await expect(
      paths.templateSlugPathForTitle('templates/journal.md', 'Log', (path) => {
        return Promise.resolve(occupied.has(path))
      }),
    ).resolves.toBe('templates/log-2.md')
  })
})

describe('slugPathForTitle', () => {
  const taken = (occupied: string[]) => (path: string) => Promise.resolve(occupied.includes(path))

  it('returns the slug path when free', async () => {
    await expect(
      paths.slugPathForTitle('notes/01abc.md', 'Meeting Notes', taken([])),
    ).resolves.toBe('notes/meeting-notes.md')
  })

  it('returns the current path unchanged when the name already matches', async () => {
    const probe = vi.fn(taken([]))
    await expect(
      paths.slugPathForTitle('notes/meeting-notes.md', 'Meeting Notes', probe),
    ).resolves.toBe('notes/meeting-notes.md')
    // Its own path is never probed — a note can't collide with itself.
    expect(probe).not.toHaveBeenCalled()
  })

  it('a suffixed home still counts as already-named (no tightening moves)', async () => {
    await expect(
      paths.slugPathForTitle('notes/meeting-2.md', 'Meeting', taken(['notes/meeting.md'])),
    ).resolves.toBe('notes/meeting-2.md')
  })

  it('suffixes around occupied candidates', async () => {
    await expect(
      paths.slugPathForTitle('notes/01abc.md', 'Meeting', taken(['notes/meeting.md'])),
    ).resolves.toBe('notes/meeting-2.md')
  })

  it('suffixes a slug that already ends in an ordinal without ambiguity', async () => {
    await expect(
      paths.slugPathForTitle('notes/01abc.md', 'Meeting 2', taken(['notes/meeting-2.md'])),
    ).resolves.toBe('notes/meeting-2-2.md')
  })

  it('fails loud instead of spinning when nothing is ever free', async () => {
    await expect(
      paths.slugPathForTitle('notes/01abc.md', 'Meeting', () => Promise.resolve(true)),
    ).rejects.toThrow(/no available note path/)
  })
})
