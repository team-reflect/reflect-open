import { afterEach, describe, expect, it } from 'vitest'
import { parseNote, setBridge, isPinned } from '@reflect/core'
import { ensureWelcomeNote, WELCOME_NOTE_PATH, WELCOME_SEEDED_META_KEY } from './welcome-note'

interface WrittenNote {
  path: string
  contents: string
}

interface FakeGraph {
  written: WrittenNote[]
  meta: Record<string, string>
}

function installFakeBridge(options: {
  existingFiles?: string[]
  meta?: Record<string, string>
}): FakeGraph {
  const graph: FakeGraph = { written: [], meta: { ...options.meta } }
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'list_files':
          return (options.existingFiles ?? []).map((path) => ({ path, size: 0, modifiedMs: 0 }))
        case 'note_write':
          graph.written.push({ path: String(args['path']), contents: String(args['contents']) })
          return null
        case 'index_meta_set':
          graph.meta[String(args['key'])] = String(args['value'])
          return null
        case 'db_query': {
          const key = String((args['params'] as unknown[])?.[0])
          return key in graph.meta ? [{ value: graph.meta[key] }] : []
        }
        default:
          throw new Error(`unexpected command: ${command}`)
      }
    },
    listen: async () => () => {},
  })
  return graph
}

const GENERATIONS = { fileGeneration: 1, indexGeneration: 7 }

afterEach(() => {
  setBridge(null)
})

describe('ensureWelcomeNote', () => {
  it('seeds a pinned, id-carrying how-to note into an empty unmarked graph and marks it', async () => {
    const graph = installFakeBridge({})
    expect(await ensureWelcomeNote(GENERATIONS)).toBe(true)
    expect(graph.written).toHaveLength(1)
    expect(graph.written[0]!.path).toBe(WELCOME_NOTE_PATH)
    expect(WELCOME_NOTE_PATH).toBe('notes/how-to-use-reflect.md')
    expect(graph.meta[WELCOME_SEEDED_META_KEY]).toBe('true')

    const { frontmatter, title } = parseNote({
      path: graph.written[0]!.path,
      source: graph.written[0]!.contents,
    })
    expect(title).toBe('How to use Reflect')
    expect(isPinned(frontmatter)).toBe(true)
    expect(frontmatter.id).toMatch(/^[0-9a-z]{26}$/)
    expect(graph.written[0]!.contents).toContain('[[Wiki Links]]')
  })

  it('marks a graph with existing notes without writing into it', async () => {
    const graph = installFakeBridge({ existingFiles: ['daily/2026-06-12.md'] })
    expect(await ensureWelcomeNote(GENERATIONS)).toBe(false)
    expect(graph.written).toHaveLength(0)
    expect(graph.meta[WELCOME_SEEDED_META_KEY]).toBe('true')
  })

  it('does nothing once marked — an emptied graph is not re-onboarded', async () => {
    const graph = installFakeBridge({ meta: { [WELCOME_SEEDED_META_KEY]: 'true' } })
    expect(await ensureWelcomeNote(GENERATIONS)).toBe(false)
    expect(graph.written).toHaveLength(0)
  })
})
