import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { getBacklinks, getBacklinksWithContext } from './queries-backlinks'

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

/** The bridge calls made so far, as `[sql, params]` pairs. */
function queries(): Array<[string, unknown[]]> {
  return mockInvoke.mock.calls.map(([command, args]) => {
    expect(command).toBe('db_query')
    return [String(args['sql']), args['params'] as unknown[]]
  })
}

describe('getBacklinks', () => {
  it('resolves a daily with no file yet through its path-derived date key', async () => {
    // note_keys has nothing for the absent daily; the links query still runs.
    mockInvoke.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        source_path: 'daily/2026-07-16.md',
        target_raw: '2026-07-29',
        alias: null,
        pos_from: 10,
        pos_to: 24,
      },
    ])

    const backlinks = await getBacklinks('daily/2026-07-29.md')

    const [keysQuery, linksQuery] = queries()
    expect(keysQuery?.[0]).toContain('"note_keys"')
    expect(keysQuery?.[1]).toEqual(['daily/2026-07-29.md'])
    expect(linksQuery?.[0]).toContain('from "links"')
    expect(linksQuery?.[0]).toContain('"links"."target_key" in')
    // Template sources never surface as backlinks (the view's guarantee, kept).
    expect(linksQuery?.[0]).toContain('"notes"."kind" !=')
    expect(linksQuery?.[1]).toEqual(['wiki', '2026-07-29', 'template'])
    expect(backlinks).toEqual([
      {
        sourcePath: 'daily/2026-07-16.md',
        targetRaw: '2026-07-29',
        alias: null,
        posFrom: 10,
        posTo: 24,
      },
    ])
  })

  it('combines note_keys spellings with the daily date key', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ key: '2026-07-29' }, { key: 'release day' }])
      .mockResolvedValueOnce([])

    await getBacklinks('daily/2026-07-29.md')

    const [, linksQuery] = queries()
    expect(linksQuery?.[1]).toEqual(['wiki', '2026-07-29', 'release day', 'template'])
  })

  it('returns empty without a links query when nothing resolves to the path', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await expect(getBacklinks('notes/does-not-exist.md')).resolves.toEqual([])
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})

describe('getBacklinksWithContext', () => {
  it('rejects a non-positive page limit', async () => {
    await expect(
      getBacklinksWithContext('daily/2026-07-29.md', { limit: 0, cursor: null }),
    ).rejects.toThrow(RangeError)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('short-circuits to an empty page when nothing resolves to the path', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await expect(
      getBacklinksWithContext('notes/does-not-exist.md', { limit: 10, cursor: null }),
    ).resolves.toEqual({ contexts: [], nextCursor: null, indexedLinkCount: 0 })
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('pages an absent daily through the links table, not the backlinks view', async () => {
    mockInvoke
      // note_keys: the daily has no file, so no rows.
      .mockResolvedValueOnce([])
      // source page query and count query (Promise.all order).
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])

    const page = await getBacklinksWithContext('daily/2026-07-29.md', {
      limit: 10,
      cursor: null,
    })

    expect(page).toEqual({ contexts: [], nextCursor: null, indexedLinkCount: 0 })
    const linkQueries = queries().slice(1)
    expect(linkQueries).toHaveLength(2)
    for (const [sqlText, params] of linkQueries) {
      expect(sqlText).toContain('from "links"')
      expect(sqlText).not.toContain('"backlinks"')
      expect(params).toContain('2026-07-29')
    }
  })
})
