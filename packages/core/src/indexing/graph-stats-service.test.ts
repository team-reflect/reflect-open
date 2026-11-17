import { describe, expect, it } from 'vitest'
import { createTestDatabaseService, seedNotes } from '../testing/database.ts'
import { createGraphStatsService } from './graph-stats-service.ts'

describe('loadGraphStats', () => {
  it('computes counts, daily span, and tag facets, excluding private notes throughout', async () => {
    const database = createTestDatabaseService()
    seedNotes(database, [
      { path: 'notes/a.md', markdown: '# A\n#Book #health\n' },
      { path: 'notes/b.md', markdown: '# B\n#book\n' },
      { path: 'notes/c.md', markdown: '# C\n' },
      { path: 'notes/secret.md', markdown: '---\nprivate: true\n---\n# Secret\n#book #hidden\n' },
      { path: 'daily/2026-01-02.md', markdown: 'Started #journal\n' },
      { path: 'daily/2026-06-01.md', markdown: 'Later\n' },
      { path: 'daily/2025-12-31.md', markdown: '---\nprivate: true\n---\nPrivate day\n' },
      { path: 'templates/journal.md', markdown: '# Journal\n#template-tag\n' },
    ])

    await expect(
      createGraphStatsService({ database }).loadGraphStats({ tagLimit: 40 }),
    ).resolves.toEqual({
      noteCount: 3,
      dailyNoteCount: 2,
      earliestDailyDate: '2026-01-02',
      latestDailyDate: '2026-06-01',
      tags: [
        { tag: 'Book', count: 2 },
        { tag: 'health', count: 1 },
      ],
      tagsTruncated: false,
    })
  })

  it('caps the facets at the limit, most-used first, and flags the truncation', async () => {
    const database = createTestDatabaseService()
    seedNotes(database, [
      { path: 'notes/one.md', markdown: '# One\n#a #b #c\n' },
      { path: 'notes/two.md', markdown: '# Two\n#a #b\n' },
      { path: 'notes/three.md', markdown: '# Three\n#a\n' },
    ])

    const stats = await createGraphStatsService({ database }).loadGraphStats({ tagLimit: 2 })

    expect(stats.tags).toEqual([
      { tag: 'a', count: 3 },
      { tag: 'b', count: 2 },
    ])
    expect(stats.tagsTruncated).toBe(true)
  })

  it('maps an empty graph to zero counts, a null span, and no tags', async () => {
    const database = createTestDatabaseService()

    await expect(
      createGraphStatsService({ database }).loadGraphStats({ tagLimit: 40 }),
    ).resolves.toEqual({
      noteCount: 0,
      dailyNoteCount: 0,
      earliestDailyDate: null,
      latestDailyDate: null,
      tags: [],
      tagsTruncated: false,
    })
  })
})
