import { describe, expect, it, vi } from 'vitest'
import { availableNotePath } from './note-paths'

describe('availableNotePath', () => {
  it('returns the bare slug path when free', async () => {
    await expect(availableNotePath('meeting', async () => false)).resolves.toBe(
      'notes/meeting.md',
    )
  })

  it('suffixes -2, -3, … until a candidate is free', async () => {
    const occupied = new Set(['notes/meeting.md', 'notes/meeting-2.md'])
    const taken = vi.fn(async (path: string) => occupied.has(path))

    await expect(availableNotePath('meeting', taken)).resolves.toBe('notes/meeting-3.md')
    expect(taken.mock.calls.map(([path]) => path)).toEqual([
      'notes/meeting.md',
      'notes/meeting-2.md',
      'notes/meeting-3.md',
    ])
  })

  it('suffixes a slug that already ends in an ordinal without ambiguity', async () => {
    const occupied = new Set(['notes/meeting-2.md'])
    await expect(
      availableNotePath('meeting-2', async (path) => occupied.has(path)),
    ).resolves.toBe('notes/meeting-2-2.md')
  })

  it('fails loud instead of spinning when nothing is ever free', async () => {
    await expect(availableNotePath('meeting', async () => true)).rejects.toThrow(
      /no available note path/,
    )
  })
})
