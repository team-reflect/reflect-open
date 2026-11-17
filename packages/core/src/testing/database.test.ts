import { describe, expect, it } from 'vitest'
import { createTestDatabaseService, seedNotes } from './database.ts'

describe('createTestDatabaseService', () => {
  it('reads back seeded notes', () => {
    const database = createTestDatabaseService()
    seedNotes(database, [
      { path: 'notes/b.md', markdown: '# B\n' },
      { path: 'notes/a.md', markdown: '# A\n' },
    ])

    const rows = database.query('SELECT path FROM notes ORDER BY path')
    expect(rows.map((row) => row['path'])).toEqual(['notes/a.md', 'notes/b.md'])
    database.close()
  })

  it('rejects queries and seeding after close', () => {
    const database = createTestDatabaseService()
    database.close()

    expect(() => database.query('select 1')).toThrow('the test database is closed')
    expect(() => seedNotes(database, [{ path: 'notes/a.md', markdown: '# A\n' }])).toThrow(
      'the test database is closed',
    )
  })
})
