import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { createNoteWithTitle, untitledNoteSeed } from './create-note'

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
      const candidate = (args?.params as unknown[])?.[0]
      return occupied.includes(String(candidate)) ? [{ path: candidate }] : []
    }
    if (command === 'note_exists') {
      return occupied.includes(String(args?.path))
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
})

describe('untitledNoteSeed', () => {
  it('is the selectable Untitled H1 plus a fresh id, unique per call', () => {
    const first = untitledNoteSeed()
    const second = untitledNoteSeed()
    expect(first).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# Untitled\n$/)
    expect(second).not.toBe(first)
  })
})
