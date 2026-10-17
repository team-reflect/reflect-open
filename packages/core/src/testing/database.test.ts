import { afterEach, describe, expect, it } from 'vitest'
import {
  createLazyTestDatabaseService,
  createTestDatabaseService,
  seedNotes,
  setTestDatabaseOpener,
  type TestDatabaseService,
} from './database.ts'

function paths(database: TestDatabaseService): Promise<readonly string[]> {
  return database.db
    .selectFrom('notes')
    .select('path')
    .orderBy('path')
    .execute()
    .then((rows) => rows.map((row) => row.path))
}

function setup() {
  const backends: TestDatabaseService[] = []
  const database = createLazyTestDatabaseService(() =>
    Promise.try(() => {
      const backend = createTestDatabaseService()
      backends.push(backend)
      return backend
    }),
  )
  return { database, backends }
}

describe('createLazyTestDatabaseService', () => {
  it('never opens a database that nothing queries', () => {
    const { database, backends } = setup()
    seedNotes(database, [{ path: 'notes/a.md', markdown: '# A\n' }])
    database.close()

    expect(backends).toEqual([])
  })

  it('opens once, writing the held projections before the first query', async () => {
    const { database, backends } = setup()
    seedNotes(database, [{ path: 'notes/a.md', markdown: '# A\n' }])
    const first = paths(database)
    seedNotes(database, [{ path: 'notes/b.md', markdown: '# B\n' }])

    await expect(first).resolves.toEqual(['notes/a.md', 'notes/b.md'])
    seedNotes(database, [{ path: 'notes/c.md', markdown: '# C\n' }])
    await expect(paths(database)).resolves.toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md'])
    expect(backends).toHaveLength(1)
    expect(database.getQueries()).toHaveLength(2)
  })

  it('rejects queries and seeding after close, and closes the opened database', async () => {
    const { database, backends } = setup()
    await paths(database)
    database.close()

    await expect(database.runQuery('select 1', [])).rejects.toMatchObject({
      kind: 'unknown',
      message: 'the test database is closed',
    })
    expect(() => seedNotes(database, [{ path: 'notes/a.md', markdown: '# A\n' }])).toThrow(
      'the test database is closed',
    )
    await expect(backends[0]!.runQuery('select 1', [])).rejects.toMatchObject({ kind: 'unknown' })
  })

  it('closes a database that finishes opening after close', async () => {
    const { database, backends } = setup()
    const query = database.runQuery('select 1', [])
    database.close()

    await expect(query).rejects.toMatchObject({ message: 'the test database is closed' })
    await expect(backends[0]!.runQuery('select 1', [])).rejects.toMatchObject({ kind: 'unknown' })
  })
})

describe('setTestDatabaseOpener', () => {
  afterEach(() => {
    setTestDatabaseOpener(null)
  })

  it('backs `createTestDatabaseService` with the installed opener until it is removed', async () => {
    const backend = createTestDatabaseService()
    seedNotes(backend, [{ path: 'notes/backend.md', markdown: '# Backend\n' }])
    setTestDatabaseOpener(() => Promise.resolve(backend))

    await expect(paths(createTestDatabaseService())).resolves.toEqual(['notes/backend.md'])

    setTestDatabaseOpener(null)
    await expect(paths(createTestDatabaseService())).resolves.toEqual([])
  })
})
