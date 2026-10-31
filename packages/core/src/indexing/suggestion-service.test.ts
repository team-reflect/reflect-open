import { describe, expect, it } from 'vitest'
import {
  createNodeTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { createSuggestionService } from './suggestion-service.ts'

function seeded(notes: readonly TestNote[]): TestDatabaseService {
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  return database
}

describe('suggestTags', () => {
  it('suggests tags containing the folded query, most-used first, never from templates', async () => {
    const database = seeded([
      { path: 'notes/a.md', markdown: '# A\n#Reading #ready\n' },
      { path: 'notes/b.md', markdown: '# B\n#reading\n' },
      { path: 'notes/c.md', markdown: '# C\n#unrelated #a_b #axb\n' },
      { path: 'templates/t.md', markdown: '# T\n#readme #readme-too\n' },
    ])
    const suggestions = createSuggestionService({ database })

    await expect(suggestions.suggestTags('READ')).resolves.toEqual([
      { tag: 'Reading', count: 2 },
      { tag: 'ready', count: 1 },
    ])
    await expect(suggestions.suggestTags('a_b')).resolves.toEqual([{ tag: 'a_b', count: 1 }])
    await expect(suggestions.suggestTags('', 1)).resolves.toEqual([{ tag: 'Reading', count: 2 }])
  })
})

describe('suggestWikiTargets', () => {
  // Wednesday, 1 January 2020, day/month — the date generator's worked-example
  // clock. This exercises the live glue (generator + merge) the editor hits;
  // the parts themselves are unit-tested in date-suggestions/suggest.
  const clock = { today: '2020-01-01', dateFormat: 'dmy' as const, weekStartDay: 'monday' as const }

  it('synthesises a daily target from a fuzzy query when given a clock', async () => {
    const database = createNodeTestDatabaseService()

    await expect(
      createSuggestionService({ database }).suggestWikiTargets('3 days ago', 8, clock),
    ).resolves.toEqual([
      {
        target: '2019-12-29',
        path: null,
        title: '2019-12-29',
        alias: null,
        date: '2019-12-29',
        generated: { phrase: '3 days ago' },
      },
    ])
  })

  it('keeps an exact title match above the generated date (folded key threaded into the merge)', async () => {
    const database = seeded([{ path: 'notes/today.md', markdown: '# Today\n' }])

    const result = await createSuggestionService({ database }).suggestWikiTargets('today', 8, clock)

    expect(result.map((row) => row.target)).toEqual(['Today', '2020-01-01'])
    expect(result[0]!.path).toBe('notes/today.md')
    expect(result[1]).toMatchObject({
      date: '2020-01-01',
      generated: { phrase: 'Today' },
      path: null,
    })
  })

  it('does not synthesise dates without a clock', async () => {
    const database = createNodeTestDatabaseService()
    await expect(
      createSuggestionService({ database }).suggestWikiTargets('today'),
    ).resolves.toEqual([])
  })

  it('still injects the bare daily for a full ISO query without a clock', async () => {
    const database = createNodeTestDatabaseService()
    await expect(
      createSuggestionService({ database }).suggestWikiTargets('2020-01-01'),
    ).resolves.toEqual([
      { target: '2020-01-01', path: null, title: '2020-01-01', alias: null, date: '2020-01-01' },
    ])
  })

  it('excludes templates from both the title and alias candidates', async () => {
    const database = seeded([
      { path: 'templates/journal.md', markdown: '---\naliases: [Journal alias]\n---\n# Journal\n' },
      { path: 'notes/journal-log.md', markdown: '# Journal log\n' },
    ])

    const result = await createSuggestionService({ database }).suggestWikiTargets('journal')

    expect(result.map((row) => row.path)).toEqual(['notes/journal-log.md'])
  })

  it('finds titles that differ only in accents, below the spelled matches', async () => {
    const database = seeded([
      { path: 'notes/eliska.md', markdown: '# Eliška Nováková\n' },
      { path: 'notes/zelisk-notes.md', markdown: '# Zelisk notes\n' },
      { path: 'notes/sarka.md', markdown: '# Šárka\n' },
      { path: 'notes/istanbul.md', markdown: '# Istanbul trip\n' },
      { path: 'notes/body.md', markdown: '# Unrelated\nEliška is only in the body.\n' },
      { path: 'templates/eliska.md', markdown: '# Eliška template\n' },
    ])
    const suggestions = createSuggestionService({ database })
    const paths = async (query: string) => {
      const rows = await suggestions.suggestWikiTargets(query)
      return rows.map((row) => row.path)
    }

    // A mid-word spelled match still ranks above an accent-only one; by title,
    // `Eliška` would sort first.
    await expect(paths('elisk')).resolves.toEqual(['notes/zelisk-notes.md', 'notes/eliska.md'])
    await expect(paths('eliska nov')).resolves.toEqual(['notes/eliska.md'])
    await expect(paths('nova eliska')).resolves.toEqual([])
    // A one-letter prefix only matches as typed; to the index, `s-` is one letter.
    await expect(paths('s')).resolves.toEqual(['notes/istanbul.md', 'notes/zelisk-notes.md'])
    await expect(paths('s-')).resolves.toEqual([])
    // `İ` lowercases to `i` plus a combining dot, which the index drops, but
    // the one-letter guard treats the dot as a separator.
    await expect(paths('İst')).resolves.toEqual(['notes/istanbul.md'])
    await expect(paths('İs')).resolves.toEqual([])
  })
})
