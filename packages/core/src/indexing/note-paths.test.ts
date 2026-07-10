import { describe, expect, it, vi } from 'vitest'
import {
  availableTemplatePath,
  slugPathForTitle,
  templateSlugPathForTitle,
} from './note-paths'

describe('availableTemplatePath', () => {
  it('probes under templates/ with the same collision suffix', async () => {
    const occupied = new Set(['templates/journal.md'])
    await expect(
      availableTemplatePath('journal', async (path) => occupied.has(path)),
    ).resolves.toBe('templates/journal-2.md')
  })
})

describe('templateSlugPathForTitle', () => {
  it('returns the template’s own path unchanged when the name already matches', async () => {
    const probe = vi.fn(async () => true)
    await expect(
      templateSlugPathForTitle('templates/journal.md', 'Journal', probe),
    ).resolves.toBe('templates/journal.md')
    // Its own path is never probed — a no-op rename must not move onto `-2`.
    expect(probe).not.toHaveBeenCalled()
  })

  it('suffixes around occupied candidates', async () => {
    const occupied = new Set(['templates/log.md'])
    await expect(
      templateSlugPathForTitle('templates/journal.md', 'Log', async (path) =>
        occupied.has(path),
      ),
    ).resolves.toBe('templates/log-2.md')
  })
})

describe('slugPathForTitle', () => {
  const taken = (occupied: string[]) => async (path: string) => occupied.includes(path)

  it('returns the slug path when free', async () => {
    await expect(
      slugPathForTitle('notes/01abc.md', 'Meeting Notes', taken([])),
    ).resolves.toBe('notes/meeting-notes.md')
  })

  it('returns the current path unchanged when the name already matches', async () => {
    const probe = vi.fn(taken([]))
    await expect(
      slugPathForTitle('notes/meeting-notes.md', 'Meeting Notes', probe),
    ).resolves.toBe('notes/meeting-notes.md')
    // Its own path is never probed — a note can't collide with itself.
    expect(probe).not.toHaveBeenCalled()
  })

  it('a suffixed home still counts as already-named (no tightening moves)', async () => {
    await expect(
      slugPathForTitle('notes/meeting-2.md', 'Meeting', taken(['notes/meeting.md'])),
    ).resolves.toBe('notes/meeting-2.md')
  })

  it('suffixes around occupied candidates', async () => {
    await expect(
      slugPathForTitle('notes/01abc.md', 'Meeting', taken(['notes/meeting.md'])),
    ).resolves.toBe('notes/meeting-2.md')
  })

  it('suffixes a slug that already ends in an ordinal without ambiguity', async () => {
    await expect(
      slugPathForTitle('notes/01abc.md', 'Meeting 2', taken(['notes/meeting-2.md'])),
    ).resolves.toBe('notes/meeting-2-2.md')
  })

  it('fails loud instead of spinning when nothing is ever free', async () => {
    await expect(
      slugPathForTitle('notes/01abc.md', 'Meeting', async () => true),
    ).rejects.toThrow(/no available note path/)
  })
})
