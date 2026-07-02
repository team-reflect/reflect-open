import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  createNoteWithTitle,
  isUntitledNotePath,
  untitledNotePath,
  untitledNoteSeed,
} from './create-note'

afterEach(() => {
  setBridge(null)
})

interface BridgeBehavior {
  /** Paths the fake graph already has (indexed and on disk alike). */
  occupied?: string[]
}

/** A fake bridge: `db_query`/`note_exists` answer from `occupied`, writes record. */
function bindBridge({ occupied = [] }: BridgeBehavior = {}): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'db_query') {
      const candidate = (args?.['params'] as unknown[])?.[0]
      return occupied.includes(String(candidate)) ? [{ path: candidate }] : []
    }
    if (command === 'note_exists') {
      return occupied.includes(String(args?.['path']))
    }
    return null
  })
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

describe('createNoteWithTitle', () => {
  it('writes a slug-named note with id frontmatter and the title as H1', async () => {
    const invoke = bindBridge()

    const path = await createNoteWithTitle('  New Idea ', 7)

    expect(path).toBe('notes/new-idea.md')
    const write = invoke.mock.calls.find(([command]) => command === 'note_write')
    expect(write).toBeDefined()
    const args = write?.[1] as { path: string; contents: string; generation: number }
    expect(args.path).toBe(path)
    expect(args.generation).toBe(7)
    expect(args.contents).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# New Idea\n$/)
  })

  it('suffixes the slug when the bare path is taken', async () => {
    bindBridge({ occupied: ['notes/new-idea.md'] })

    await expect(createNoteWithTitle('New Idea', 7)).resolves.toBe('notes/new-idea-2.md')
  })

  it('places an optional body block under the H1', async () => {
    const invoke = bindBridge()

    await createNoteWithTitle('Ada Lovelace', 7, '- Type: #person')

    const write = invoke.mock.calls.find(([command]) => command === 'note_write')
    const args = write?.[1] as { contents: string }
    expect(args.contents).toMatch(
      /^---\nid: [0-9a-z]{26}\n---\n# Ada Lovelace\n\n- Type: #person\n$/,
    )
  })
})

describe('untitledNoteSeed', () => {
  it('is an empty H1 (the caret lands there) plus a fresh id, unique per call', () => {
    const first = untitledNoteSeed()
    const second = untitledNoteSeed()
    expect(first).toMatch(/^---\nid: [0-9a-z]{26}\n---\n#\n$/)
    expect(second).not.toBe(first)
  })
})

describe('isUntitledNotePath', () => {
  it('recognizes the ULID placeholder paths untitledNotePath mints', () => {
    expect(isUntitledNotePath(untitledNotePath())).toBe(true)
  })

  it('rejects slug-named, daily, and near-miss paths', () => {
    expect(isUntitledNotePath('notes/meeting-notes.md')).toBe(false)
    expect(isUntitledNotePath('daily/2026-06-12.md')).toBe(false)
    // Right length, but `u` is outside the Crockford base32 alphabet.
    expect(isUntitledNotePath('notes/uuuuuuuuuuuuuuuuuuuuuuuuuu.md')).toBe(false)
    // A ULID-shaped name outside notes/ is not a placeholder.
    expect(isUntitledNotePath('01jxk2v9qz3m4n5p6r7s8t9vwx.md')).toBe(false)
  })
})
