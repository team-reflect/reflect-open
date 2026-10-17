import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestIpcBridgeService } from '../testing/index.ts'
import { createDatabaseService } from './database-service.ts'
describe('createDatabaseService', () => {
  it('sends each compiled query as `db_query`', async () => {
    const ipc = createTestIpcBridgeService({ commands: { db_query: () => [{ path: 'a.md' }] } })
    const database = createDatabaseService({ ipc })

    const rows = await database.db
      .selectFrom('notes')
      .select('path')
      .where('kind', '=', 'note')
      .execute()

    expect(rows).toEqual([{ path: 'a.md' }])
    expect(ipc.calls()).toEqual([
      {
        command: 'db_query',
        args: { sql: 'select "path" from "notes" where "kind" = ?', params: ['note'] },
      },
    ])
  })

  it('fails a response that is not a row array', async () => {
    const ipc = createTestIpcBridgeService({ commands: { db_query: () => ({ rows: [] }) } })
    const database = createDatabaseService({ ipc })

    await expect(database.db.selectFrom('notes').selectAll().execute()).rejects.toThrow(
      'db_query did not return a row array',
    )
  })

  it('rejects a failed query with its app error', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        db_query: () => {
          throw new AppError('io', 'index locked')
        },
      },
    })
    const database = createDatabaseService({ ipc })

    await expect(database.runQuery('select 1', [])).rejects.toEqual(
      new AppError('io', 'index locked'),
    )
  })

  it('rejects transactions', async () => {
    const database = createDatabaseService({ ipc: createTestIpcBridgeService() })

    await expect(database.db.transaction().execute(async () => {})).rejects.toThrow(
      'transactions run in Rust',
    )
  })
})
