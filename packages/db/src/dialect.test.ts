import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from './db'

const runQuery = vi.fn<(sql: string, params: readonly unknown[]) => Promise<unknown>>()

beforeEach(() => {
  runQuery.mockReset()
})

describe('IpcDialect (Kysely → injected runner bridge)', () => {
  it('compiles to snake_case SQL and hands it to the runner with params', async () => {
    runQuery.mockResolvedValue([])
    const db = createDb(runQuery)
    await db
      .selectFrom('notes')
      .select(['path', 'fileHash'])
      .where('titleKey', '=', 'project x')
      .execute()

    expect(runQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = runQuery.mock.calls[0]!
    expect(sql).toContain('"file_hash"')
    expect(sql).toContain('"title_key"')
    expect(params).toEqual(['project x'])
  })

  it('maps snake_case result columns back to camelCase', async () => {
    runQuery.mockResolvedValue([{ path: 'notes/a.md', file_hash: 'abc' }])
    const db = createDb(runQuery)
    const rows = await db.selectFrom('notes').select(['path', 'fileHash']).execute()
    expect(rows).toEqual([{ path: 'notes/a.md', fileHash: 'abc' }])
  })

  it('fails fast when the runner returns a non-array payload', async () => {
    runQuery.mockResolvedValue({ not: 'an array' })
    const db = createDb(runQuery)
    await expect(db.selectFrom('notes').selectAll().execute()).rejects.toThrow(/row array/)
  })

  it('rejects transactions — writes go through the index_* commands', async () => {
    runQuery.mockResolvedValue([])
    const db = createDb(runQuery)
    await expect(db.transaction().execute(async () => undefined)).rejects.toThrow(
      /transactions run in Rust/,
    )
  })
})
