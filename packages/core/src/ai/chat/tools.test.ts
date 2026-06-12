import { describe, expect, it } from 'vitest'
import type { ToolCallOptions } from 'ai'
import type { RetrievalHit, RetrieveOptions } from '../../embeddings/retrieve'
import type { DailyNoteRow, DailyNotesRange } from '../../indexing/queries'
import type { RecentNoteRow, RecentNotesOptions } from '../../indexing/note-list'
import {
  buildNoteTools,
  INVALID_TAG_ERROR,
  MAX_DAILY_NOTE_DAYS,
  MAX_NOTE_CONTENT_CHARS,
  type ListDailyNotesOutput,
  type ListRecentNotesOutput,
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

/** A public retrieval hit, overridable per test. */
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

/** A public recents query row, overridable per test. */
function recentRow(overrides: Partial<RecentNoteRow>): RecentNoteRow {
  return {
    path: 'notes/public.md',
    title: 'Public note',
    preview: 'a public preview',
    mtime: 1_750_000_000_000,
    isPrivate: false,
    ...overrides,
  }
}

/** A public daily query row for `date`, overridable per test. */
function dailyRow(date: string, overrides: Partial<DailyNoteRow> = {}): DailyNoteRow {
  return {
    path: `daily/${date}.md`,
    title: date,
    dailyDate: date,
    preview: 'a daily preview',
    mtime: 1_750_000_000_000,
    isPrivate: false,
    ...overrides,
  }
}

function isAsyncIterable(value: object): value is AsyncIterable<unknown> {
  return Symbol.asyncIterator in value
}

/** Execute `search_notes` directly, asserting a non-streaming output. */
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

/** Execute `read_note` directly, asserting a non-streaming output. */
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

/** Execute `list_recent_notes` directly, asserting a non-streaming output. */
async function runRecents(
  tools: NoteTools,
  input: { limit?: number; tag?: string | null },
): Promise<ListRecentNotesOutput> {
  const execute = tools.list_recent_notes.execute
  if (!execute) {
    throw new Error('list_recent_notes has no execute')
  }
  const output = await execute(input, CALL)
  if (isAsyncIterable(output)) {
    throw new Error('unexpected streaming tool output')
  }
  return output
}

/** Execute `list_daily_notes` directly, asserting a non-streaming output. */
async function runDailies(
  tools: NoteTools,
  input: { start: string; end: string },
): Promise<ListDailyNotesOutput> {
  const execute = tools.list_daily_notes.execute
  if (!execute) {
    throw new Error('list_daily_notes has no execute')
  }
  const output = await execute(input, CALL)
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
      readNoteFn: async () => 'a public body\n',
    })
    const output = await runSearch(tools, { query: 'diary' })
    const payload = JSON.stringify(output)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(output.hits).toEqual([
      { path: 'notes/public.md', title: 'Public note', snippet: 'a public snippet', heading: null },
    ])
  })

  it('drops a hit whose live frontmatter turned private before reindex (TOCTOU)', async () => {
    const tools = buildNoteTools({
      // The stale index still says public…
      retrieveFn: async () => [hit({ path: PRIVATE_PATH, title: PRIVATE_TITLE })],
      // …but the note on disk was just marked private.
      readNoteFn: async () => '---\nprivate: true\n---\n# Diary\n',
    })
    const output = await runSearch(tools, { query: 'diary' })
    expect(output.hits).toEqual([])
    expect(JSON.stringify(output)).not.toContain(PRIVATE_TITLE)
  })

  it('fails closed: an unreadable hit is dropped, not sent', async () => {
    const tools = buildNoteTools({
      retrieveFn: async () => [hit({ path: PRIVATE_PATH, title: PRIVATE_TITLE })],
      readNoteFn: async () => {
        throw { kind: 'io', message: 'disk error' }
      },
    })
    const output = await runSearch(tools, { query: 'diary' })
    expect(output.hits).toEqual([])
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

describe('list_recent_notes', () => {
  it('queries with the default limit and no tag', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: async (options) => {
        seen.push(options)
        return []
      },
    })
    await runRecents(tools, {})
    expect(seen).toEqual([{ limit: 10, tag: null }])
  })

  it('passes an explicit limit and tag through', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: async (options) => {
        seen.push(options)
        return []
      },
    })
    await runRecents(tools, { limit: 3, tag: 'book' })
    expect(seen).toEqual([{ limit: 3, tag: 'book' }])
  })

  it('treats an explicit null tag as no filter', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: async (options) => {
        seen.push(options)
        return []
      },
    })
    await runRecents(tools, { tag: null })
    expect(seen).toEqual([{ limit: 10, tag: null }])
  })

  it('refuses a non-tag filter without querying, pointing at the no-tag call', async () => {
    const seen: RecentNotesOptions[] = []
    const tools = buildNoteTools({
      listRecentNotesFn: async (options) => {
        seen.push(options)
        return []
      },
    })
    for (const tag of ['*', ' ', '#book', ']INVALIDNOFILTER[']) {
      const output = await runRecents(tools, { tag })
      if (output.ok) {
        expect.unreachable('expected a refusal')
      }
      expect(output.tag).toBe(tag)
      expect(output.error).toBe(INVALID_TAG_ERROR)
    }
    expect(seen).toEqual([])
  })

  it('maps rows onto listings: preview as snippet, ISO modifiedAt, no daily date', async () => {
    const mtime = 1_750_000_000_000
    const tools = buildNoteTools({
      listRecentNotesFn: async () => [recentRow({ mtime })],
      readNoteFn: async () => 'a public body\n',
    })
    const output = await runRecents(tools, {})
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toEqual([
      {
        path: 'notes/public.md',
        title: 'Public note',
        dailyDate: null,
        snippet: 'a public preview',
        modifiedAt: new Date(mtime).toISOString(),
      },
    ])
  })

  it('drops an indexed-private row entirely — not even the title goes out', async () => {
    const tools = buildNoteTools({
      listRecentNotesFn: async () => [
        recentRow({}),
        recentRow({ path: PRIVATE_PATH, title: PRIVATE_TITLE, isPrivate: true }),
      ],
      readNoteFn: async () => 'a public body\n',
    })
    const output = await runRecents(tools, {})
    const payload = JSON.stringify(output)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toHaveLength(1)
  })

  it('drops a row whose live frontmatter turned private before reindex (TOCTOU)', async () => {
    const tools = buildNoteTools({
      listRecentNotesFn: async () => [recentRow({ path: PRIVATE_PATH, title: PRIVATE_TITLE })],
      readNoteFn: async () => '---\nprivate: true\n---\n# Diary\n',
    })
    const output = await runRecents(tools, {})
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toEqual([])
    expect(JSON.stringify(output)).not.toContain(PRIVATE_TITLE)
  })

  it('fails closed: an unreadable row is dropped, not sent', async () => {
    const tools = buildNoteTools({
      listRecentNotesFn: async () => [recentRow({})],
      readNoteFn: async () => {
        throw { kind: 'io', message: 'disk error' }
      },
    })
    const output = await runRecents(tools, {})
    if (!output.ok) {
      expect.unreachable('expected a listing')
    }
    expect(output.notes).toEqual([])
  })
})

describe('list_daily_notes', () => {
  it('queries the inclusive range with one row past the day cap', async () => {
    const seen: DailyNotesRange[] = []
    const tools = buildNoteTools({
      listDailyNotesFn: async (range) => {
        seen.push(range)
        return []
      },
    })
    await runDailies(tools, { start: '2026-06-01', end: '2026-06-30' })
    expect(seen).toEqual([
      { start: '2026-06-01', end: '2026-06-30', limit: MAX_DAILY_NOTE_DAYS + 1 },
    ])
  })

  it('maps days with their dates and stays untruncated within the cap', async () => {
    const tools = buildNoteTools({
      listDailyNotesFn: async () => [dailyRow('2026-06-10'), dailyRow('2026-06-09')],
      readNoteFn: async () => 'a public body\n',
    })
    const output = await runDailies(tools, { start: '2026-06-01', end: '2026-06-30' })
    expect(output.truncated).toBe(false)
    expect(output.days.map((day) => day.dailyDate)).toEqual(['2026-06-10', '2026-06-09'])
    expect(output.days[0]?.path).toBe('daily/2026-06-10.md')
  })

  it('cuts an over-cap range to the cap and flags the truncation', async () => {
    const days = Array.from({ length: MAX_DAILY_NOTE_DAYS + 1 }, (_, index) =>
      dailyRow(`2026-05-${String(index + 1).padStart(2, '0')}`),
    )
    const tools = buildNoteTools({
      listDailyNotesFn: async () => days,
      readNoteFn: async () => 'a public body\n',
    })
    const output = await runDailies(tools, { start: '2026-05-01', end: '2026-06-30' })
    expect(output.truncated).toBe(true)
    expect(output.days).toHaveLength(MAX_DAILY_NOTE_DAYS)
  })

  it('drops a daily whose live frontmatter turned private before reindex (TOCTOU)', async () => {
    const tools = buildNoteTools({
      listDailyNotesFn: async () => [
        dailyRow('2026-06-10', { path: PRIVATE_PATH, title: PRIVATE_TITLE }),
      ],
      readNoteFn: async () => '---\nprivate: true\n---\n# Diary\n',
    })
    const output = await runDailies(tools, { start: '2026-06-01', end: '2026-06-30' })
    expect(output.days).toEqual([])
    expect(JSON.stringify(output)).not.toContain(PRIVATE_TITLE)
  })
})
