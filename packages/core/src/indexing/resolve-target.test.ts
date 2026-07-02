import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { foldKey } from '../markdown'
import { resolveNoteTarget } from './resolve-target'

// Same fake-bridge harness as queries.test: `db_query` resolves against the
// mock, so the tests pin the real compiled SQL and the resolution order.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

function queryCalls(): { sql: string; params: unknown[] }[] {
  return mockInvoke.mock.calls.map(([, args]) => ({
    sql: String(args['sql']),
    params: args['params'] as unknown[],
  }))
}

describe('resolveNoteTarget', () => {
  it('resolves a frontmatter id first, without falling through', async () => {
    mockInvoke.mockResolvedValueOnce([{ path: 'notes/project-x.md' }])

    await expect(resolveNoteTarget('01hzy3v9k2m4n6p8q0r2s4t6vw')).resolves.toBe(
      'notes/project-x.md',
    )

    const calls = queryCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sql).toContain('"id" = ?')
    expect(calls[0]!.sql).toContain('order by "path"')
    expect(calls[0]!.params).toEqual(['01hzy3v9k2m4n6p8q0r2s4t6vw'])
  })

  it('resolves a calendar date to the daily path even when the file does not exist', async () => {
    mockInvoke.mockResolvedValueOnce([]) // no id match

    await expect(resolveNoteTarget('2026-07-01')).resolves.toBe('daily/2026-07-01.md')
    expect(queryCalls()).toHaveLength(1)
  })

  it('does not treat an impossible date as a daily note', async () => {
    mockInvoke.mockResolvedValue([])

    await expect(resolveNoteTarget('2026-02-31')).resolves.toBeNull()
  })

  it('resolves an explicit graph-relative path when the index knows it', async () => {
    mockInvoke.mockResolvedValueOnce([]) // id
    mockInvoke.mockResolvedValueOnce([{ path: 'notes/foo.md' }]) // path

    await expect(resolveNoteTarget('notes/foo.md')).resolves.toBe('notes/foo.md')

    const calls = queryCalls()
    expect(calls[1]!.sql).toContain('"path" = ?')
    expect(calls[1]!.params).toEqual(['notes/foo.md'])
  })

  it('falls back to a case-folded title match, first path alphabetically', async () => {
    mockInvoke.mockResolvedValueOnce([]) // id
    mockInvoke.mockResolvedValueOnce([]) // path
    mockInvoke.mockResolvedValueOnce([{ path: 'notes/project-x.md' }]) // title

    await expect(resolveNoteTarget('Project X')).resolves.toBe('notes/project-x.md')

    const calls = queryCalls()
    expect(calls[2]!.sql).toContain('"title_key" = ?')
    expect(calls[2]!.sql).toContain('order by "path"')
    expect(calls[2]!.params).toEqual([foldKey('Project X')])
  })

  it('falls back to an alias match last, and to null when nothing matches', async () => {
    mockInvoke.mockResolvedValueOnce([]) // id
    mockInvoke.mockResolvedValueOnce([]) // path
    mockInvoke.mockResolvedValueOnce([]) // title
    mockInvoke.mockResolvedValueOnce([{ note_path: 'notes/aliased.md' }]) // alias

    await expect(resolveNoteTarget('PX')).resolves.toBe('notes/aliased.md')

    const calls = queryCalls()
    expect(calls[3]!.sql).toContain('"alias_key" = ?')
    expect(calls[3]!.params).toEqual([foldKey('PX')])

    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue([])
    await expect(resolveNoteTarget('nothing matches this')).resolves.toBeNull()
  })
})
