import { describe, expect, it } from 'vitest'
import type { ToolCallOptions } from 'ai'
import type { RetrievalHit, RetrieveOptions } from '../../embeddings/retrieve'
import {
  buildNoteTools,
  MAX_NOTE_CONTENT_CHARS,
  type NoteTools,
  type ReadNoteOutput,
  type SearchNotesOutput,
} from './tools'

const CALL: ToolCallOptions = { toolCallId: 'call-1', messages: [] }

// Sentinels that cannot collide with prompt copy or fixture prose, so the
// not-in-payload assertions below can never pass vacuously.
const PRIVATE_TITLE = 'sentinel-title-01jxq3'
const PRIVATE_PATH = 'notes/sentinel-path-01jxq3.md'
const PRIVATE_BODY = 'sentinel-body-01jxq3'

function hit(overrides: Partial<RetrievalHit>): RetrievalHit {
  return {
    path: 'notes/public.md',
    title: 'Public note',
    score: 1,
    snippet: 'a public snippet',
    heading: null,
    isPrivate: false,
    ...overrides,
  }
}

function isAsyncIterable(value: object): value is AsyncIterable<unknown> {
  return Symbol.asyncIterator in value
}

async function runSearch(
  tools: NoteTools,
  input: { query: string; limit?: number },
): Promise<SearchNotesOutput> {
  const execute = tools.search_notes.execute
  if (!execute) {
    throw new Error('search_notes has no execute')
  }
  const output = await execute(input, CALL)
  if (isAsyncIterable(output)) {
    throw new Error('unexpected streaming tool output')
  }
  return output
}

async function runRead(tools: NoteTools, path: string): Promise<ReadNoteOutput> {
  const execute = tools.read_note.execute
  if (!execute) {
    throw new Error('read_note has no execute')
  }
  const output = await execute({ path }, CALL)
  if (isAsyncIterable(output)) {
    throw new Error('unexpected streaming tool output')
  }
  return output
}

describe('search_notes', () => {
  it('always retrieves with excludePrivateContent', async () => {
    const seen: Array<RetrieveOptions | undefined> = []
    const tools = buildNoteTools({
      retrieveFn: async (_query, options) => {
        seen.push(options)
        return []
      },
    })
    await runSearch(tools, { query: 'atlas' })
    expect(seen).toEqual([{ limit: 8, excludePrivateContent: true }])
  })

  it('drops private hits entirely — not even the title goes out', async () => {
    const tools = buildNoteTools({
      retrieveFn: async () => [
        hit({}),
        hit({ path: PRIVATE_PATH, title: PRIVATE_TITLE, snippet: '', isPrivate: true }),
      ],
    })
    const output = await runSearch(tools, { query: 'diary' })
    const payload = JSON.stringify(output)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(output.hits).toEqual([
      { path: 'notes/public.md', title: 'Public note', snippet: 'a public snippet', heading: null },
    ])
  })

  it('passes the requested limit through', async () => {
    const seen: Array<RetrieveOptions | undefined> = []
    const tools = buildNoteTools({
      retrieveFn: async (_query, options) => {
        seen.push(options)
        return []
      },
    })
    await runSearch(tools, { query: 'atlas', limit: 3 })
    expect(seen[0]?.limit).toBe(3)
  })
})

describe('read_note', () => {
  it('returns the body without frontmatter, titled from the note', async () => {
    const tools = buildNoteTools({
      readNoteFn: async () => '---\npinned: true\n---\n# Project Atlas\n\nLaunch plan.\n',
    })
    const output = await runRead(tools, 'notes/atlas.md')
    if (!output.ok) {
      expect.unreachable('expected a successful read')
    }
    expect(output.note.title).toBe('Project Atlas')
    expect(output.note.content).toBe('# Project Atlas\n\nLaunch plan.\n')
    expect(output.note.truncated).toBe(false)
  })

  it('refuses a private note from its live frontmatter', async () => {
    const tools = buildNoteTools({
      readNoteFn: async () => `---\nprivate: true\n---\n# Diary\n\n${PRIVATE_BODY}\n`,
    })
    const output = await runRead(tools, PRIVATE_PATH)
    if (output.ok) {
      expect.unreachable('expected a refusal')
    }
    expect(output.error).toContain('private')
    expect(JSON.stringify(output)).not.toContain(PRIVATE_BODY)
  })

  it('reports a missing note instead of throwing', async () => {
    const tools = buildNoteTools({
      readNoteFn: async () => {
        throw { kind: 'notFound', message: 'no such note' }
      },
    })
    const output = await runRead(tools, 'notes/gone.md')
    if (output.ok) {
      expect.unreachable('expected a miss')
    }
    expect(output.error).toContain('No note exists')
  })

  it('caps oversized notes and flags the cut', async () => {
    const body = 'x'.repeat(MAX_NOTE_CONTENT_CHARS + 10)
    const tools = buildNoteTools({ readNoteFn: async () => body })
    const output = await runRead(tools, 'notes/big.md')
    if (!output.ok) {
      expect.unreachable('expected a successful read')
    }
    expect(output.note.content.length).toBe(MAX_NOTE_CONTENT_CHARS)
    expect(output.note.truncated).toBe(true)
  })
})
