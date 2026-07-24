import { describe, expect, it } from 'vitest'
import { parseNote } from '../markdown'
import { setBridge } from '../ipc/bridge'
import {
  applyProjection,
  connectIndex,
  expectSuggestionOpensItsPath,
  openMigratedIndex,
  project,
} from './flow-test-harness'
import {
  getBacklinks,
  getLinkSources,
  resolveWikiTarget,
  suggestWikiLinkTargets,
  suggestWikiTargets,
} from './queries'
import { rewriteLinksForTitleChange } from './rename'

describe('v1 subject alias flow', () => {
  it('retitles a display reached through a stable subject alias', async () => {
    const database = openMigratedIndex()
    const subjectPath = 'notes/capture.md'
    const sourcePath = 'daily/2026-07-23.md'
    const source = '[[capture-2026-07-23-154848|Old Title]]\n'
    applyProjection(
      database,
      project(
        subjectPath,
        '---\naliases:\n  - capture-2026-07-23-154848\n---\n# Old Title\n',
        20,
      ),
    )
    applyProjection(database, project(sourcePath, source, 10))
    connectIndex(database)

    try {
      const writes: Record<string, string> = {}
      await rewriteLinksForTitleChange({
        path: subjectPath,
        from: 'Old Title',
        to: 'New Title',
        io: {
          sources: getLinkSources,
          backlinks: getBacklinks,
          read: async () => source,
          write: async (path, content) => {
            writes[path] = content
          },
          resolve: resolveWikiTarget,
        },
      })

      expect(writes).toEqual({
        [sourcePath]: '[[capture-2026-07-23-154848|New Title]]\n',
      })
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('projects, resolves, backlinks, and autocompletes Dad through the real schema', async () => {
    const database = openMigratedIndex()
    const person = project('notes/tim-maccaw-dad.md', '# Tim MacCaw // Dad\n', 20)
    const source = project('notes/family.md', '# Family\n\nCall [[Dad]].\n', 10)

    expect(person.aliases).toEqual([
      { alias: 'Tim MacCaw', aliasKey: 'tim maccaw' },
      { alias: 'Dad', aliasKey: 'dad' },
    ])
    applyProjection(database, person)
    applyProjection(database, source)

    connectIndex(database)

    try {
      await expect(resolveWikiTarget('Dad')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/tim-maccaw-dad.md',
      })
      await expect(getBacklinks('notes/tim-maccaw-dad.md')).resolves.toMatchObject([
        { sourcePath: 'notes/family.md', targetRaw: 'Dad' },
      ])

      const { suggestions } = await suggestWikiLinkTargets('Dad')
      expect(suggestions[0]).toMatchObject({
        target: 'Tim MacCaw // Dad',
        path: 'notes/tim-maccaw-dad.md',
        title: 'Tim MacCaw // Dad',
        alias: 'Dad',
      })
      const inserted = suggestions[0]!.insertText
      expect(inserted).toBe('Tim MacCaw // Dad|Dad')
      expect(parseNote({ path: 'notes/selected.md', source: `[[${inserted}]]` }).wikiLinks).toEqual([
        expect.objectContaining({ target: 'Tim MacCaw // Dad', alias: 'Dad' }),
      ])

      // A standalone title is a stronger claimant than the subject alias. The
      // link, backlink, and autocomplete ranking must all move together.
      const standaloneDad = project('notes/dad.md', '# Dad\n', 30)
      applyProjection(database, standaloneDad)
      await expect(resolveWikiTarget('Dad')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/dad.md',
      })
      await expect(getBacklinks('notes/tim-maccaw-dad.md')).resolves.toEqual([])
      await expect(getBacklinks('notes/dad.md')).resolves.toMatchObject([
        { sourcePath: 'notes/family.md', targetRaw: 'Dad' },
      ])

      const selected = project(
        'notes/selected.md',
        `# Selected\n\nCall [[${inserted}]].\n`,
        40,
      )
      applyProjection(database, selected)
      expect(selected.links).toEqual([
        expect.objectContaining({
          targetRaw: 'Tim MacCaw // Dad',
          targetKey: 'tim maccaw // dad',
          alias: 'Dad',
        }),
      ])
      await expect(resolveWikiTarget(selected.links[0]!.targetRaw)).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/tim-maccaw-dad.md',
      })
      await expect(getBacklinks('notes/tim-maccaw-dad.md')).resolves.toMatchObject([
        {
          sourcePath: 'notes/selected.md',
          targetRaw: 'Tim MacCaw // Dad',
          alias: 'Dad',
        },
      ])
      await expect(getBacklinks('notes/dad.md')).resolves.toMatchObject([
        { sourcePath: 'notes/family.md', targetRaw: 'Dad' },
      ])

      const { suggestions: collidedSuggestions } =
        await suggestWikiLinkTargets('Dad')
      expect(collidedSuggestions.map((suggestion) => suggestion.path)).toEqual([
        'notes/dad.md',
        'notes/tim-maccaw-dad.md',
      ])
      expect(collidedSuggestions[0]!.insertText).toBe('Dad')
      expect(collidedSuggestions[1]!.insertText).toBe('Tim MacCaw // Dad|Dad')
      await Promise.all(collidedSuggestions.map(expectSuggestionOpensItsPath))
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('offers only suggestions whose serialized address resolves to the selected note', async () => {
    const database = openMigratedIndex()
    const projections = [
      // A calendar-valid daily address outranks a regular note with that title,
      // even when the daily's custom H1 keeps it out of the title search hits.
      project('daily/2026-07-10.md', '# Friday Journal\n', 10),
      project('notes/date-title.md', '# 2026-07-10\n', 90),
      // Without a daily, a regular note may own a valid date key. A generated
      // date phrase must not masquerade as a daily and navigate to this note.
      project('notes/tomorrow-title.md', '# 2026-07-11\n', 92),
      // A shape-valid but impossible daily path is only an ordinary title
      // claimant. Its daily_date projection must not block the real title.
      project('daily/2026-02-31.md', '# Invalid date file\n', 15),
      project('notes/invalid-date-title.md', '# 2026-02-31\n', 95),
      // Ordinary duplicate titles are ambiguous for writable navigation, so
      // neither title-only candidate is selectable irrespective of recency.
      project('notes/a-roadmap.md', '# Roadmap\n', 20),
      project('notes/z-roadmap.md', '# Roadmap\n', 100),
      // A leading-emoji duplicate collides with a bare query only through
      // fallback folding; the filtered claim must still reach the editor.
      // The paths are the slug family `slugForTitle` really produces, the
      // same family the writable resolver's disk guard scans.
      project('notes/ideas.md', '# 🧠 Ideas\n', 22),
      project('notes/ideas-2.md', '# 🧠 Ideas\n', 102),
      // Date-shaped duplicate titles are ambiguous for the writable click
      // path, exactly like other duplicates, so neither twin is selectable.
      project('notes/a-date-twin.md', '# 2026-07-12\n', 25),
      project('notes/z-date-twin.md', '# 2026-07-12\n', 105),
      // A duplicate-title candidate can still be addressed through its own
      // unique alias. The verified insertion must use that alias, not Shared.
      project('notes/a-shared.md', '# Shared\n', 30),
      project(
        'notes/z-shared.md',
        '---\naliases:\n  - Second Shared\n---\n# Shared\n',
        110,
      ),
      // Raw alias keys survive ranking even when the same note's stronger
      // title candidate wins deduplication.
      project(
        'notes/ada-project.md',
        '---\naliases:\n  - Ada Lovelace\n---\n# Ada Project\n',
        115,
      ),
      // An unserializable alias is only a lost display text: the note stays
      // selectable through its safe, uniquely claimed canonical title.
      project(
        'notes/zeta-project.md',
        "---\naliases:\n  - 'Zeta|Prime'\n---\n# Zeta Project\n",
        118,
      ),
      // Unsafe syntax is never silently cleaned into a different key.
      project('notes/unsafe.md', '# Unsafe | Title\n', 120),
      project(
        'notes/escaped.md',
        "---\ntitle: 'Escape \\. Title'\n---\nBody\n",
        130,
      ),
    ]
    for (const projection of projections) {
      applyProjection(database, projection)
    }
    connectIndex(database)

    try {
      const dateContext = {
        today: '2026-07-10',
        dateFormat: 'dmy' as const,
        weekStartDay: 'monday' as const,
      }
      const { suggestions: dateSuggestions } =
        await suggestWikiLinkTargets('2026-07-10')
      expect(dateSuggestions.map((suggestion) => suggestion.path)).toEqual([
        'daily/2026-07-10.md',
      ])
      const { suggestions: fuzzyDateSuggestions } =
        await suggestWikiLinkTargets('today', 8, dateContext)
      expect(fuzzyDateSuggestions).toMatchObject([
        {
          target: '2026-07-10',
          path: 'daily/2026-07-10.md',
          insertText: '2026-07-10',
          generated: { phrase: 'Today' },
        },
      ])
      await expect(
        suggestWikiLinkTargets('tomorrow', 8, dateContext),
      ).resolves.toEqual({
        suggestions: [],
        claimedTargetKeys: ['2026-07-11'],
        queryReadsAsDate: true,
      })
      const { suggestions: invalidDateSuggestions } =
        await suggestWikiLinkTargets('2026-02-31')
      expect(invalidDateSuggestions.map((suggestion) => suggestion.path)).toEqual([
        'notes/invalid-date-title.md',
      ])

      const duplicateResult = await suggestWikiLinkTargets('Roadmap')
      expect(duplicateResult).toEqual({
        suggestions: [],
        claimedTargetKeys: ['roadmap'],
        queryReadsAsDate: false,
      })
      await expect(suggestWikiLinkTargets('Road')).resolves.toEqual({
        suggestions: [],
        claimedTargetKeys: ['roadmap'],
        queryReadsAsDate: false,
      })
      const navigationSuggestions = await suggestWikiTargets('Roadmap')
      expect(navigationSuggestions.map((suggestion) => suggestion.path)).toEqual([
        'notes/z-roadmap.md',
        'notes/a-roadmap.md',
      ])

      // Both `🧠 Ideas` twins are filtered, but their claimed key still
      // reaches the editor so its fallback folding can suppress a Create row
      // that the writable resolver would refuse as ambiguous.
      await expect(suggestWikiLinkTargets('Ideas')).resolves.toEqual({
        suggestions: [],
        claimedTargetKeys: ['🧠 ideas'],
        queryReadsAsDate: false,
      })

      // A duplicate date-shaped title would open an ambiguity error, not the
      // suggested note, so it is omitted like any other duplicate title.
      await expect(suggestWikiLinkTargets('2026-07-12')).resolves.toEqual({
        suggestions: [],
        claimedTargetKeys: ['2026-07-12'],
        queryReadsAsDate: false,
      })
      // A uniquely claimed date-shaped title stays addressable.
      const { suggestions: dateTitleSuggestions } =
        await suggestWikiLinkTargets('2026-07-11')
      expect(dateTitleSuggestions.map((suggestion) => suggestion.path)).toEqual([
        'notes/tomorrow-title.md',
      ])

      const { suggestions: aliasSuggestions } =
        await suggestWikiLinkTargets('Second Shared')
      expect(aliasSuggestions).toHaveLength(1)
      expect(aliasSuggestions[0]).toMatchObject({
        path: 'notes/z-shared.md',
        target: 'Shared',
        alias: 'Second Shared',
        insertText: 'Second Shared',
      })

      // Matching the duplicate *title* must not hide a uniquely addressable
      // note: its ambiguous ranked spelling is rescued through its unique alias.
      const sharedTitleResult = await suggestWikiLinkTargets('Shared')
      const { suggestions: sharedTitleSuggestions } = sharedTitleResult
      expect(sharedTitleResult.claimedTargetKeys).toEqual([
        'second shared',
        'shared',
      ])
      expect(sharedTitleSuggestions).toMatchObject([
        {
          path: 'notes/z-shared.md',
          target: 'Shared',
          alias: 'Second Shared',
          insertText: 'Second Shared',
        },
      ])

      const adaResult = await suggestWikiLinkTargets('Ada')
      expect(adaResult.claimedTargetKeys).toEqual([
        'ada lovelace',
        'ada project',
      ])
      expect(adaResult.suggestions).toMatchObject([
        { path: 'notes/ada-project.md', target: 'Ada Project' },
      ])

      await Promise.all(
        [
          ...dateSuggestions,
          ...fuzzyDateSuggestions,
          ...invalidDateSuggestions,
          ...dateTitleSuggestions,
          ...aliasSuggestions,
          ...sharedTitleSuggestions,
          ...adaResult.suggestions,
        ].map(expectSuggestionOpensItsPath),
      )
      // The matched alias cannot be serialized, so insertion falls back to
      // the bare canonical title instead of dropping the note.
      const { suggestions: unsafeAliasSuggestions } =
        await suggestWikiLinkTargets('Zeta|Prime')
      expect(unsafeAliasSuggestions).toMatchObject([
        {
          path: 'notes/zeta-project.md',
          target: 'Zeta Project',
          alias: 'Zeta|Prime',
          insertText: 'Zeta Project',
        },
      ])
      await Promise.all(unsafeAliasSuggestions.map(expectSuggestionOpensItsPath))

      await expect(suggestWikiLinkTargets('Unsafe | Title')).resolves.toMatchObject({
        suggestions: [],
      })
      await expect(suggestWikiLinkTargets('Escape \\. Title')).resolves.toMatchObject({
        suggestions: [],
      })
    } finally {
      setBridge(null)
      database.close()
    }
  })
})
