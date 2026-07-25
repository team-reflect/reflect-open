import { describe, expect, it } from 'vitest'
import { parseNote } from '../markdown'
import { foldKey } from '../markdown/keys'
import {
  isWikiLinkSafeText,
  mergeDateSuggestions,
  rankWikiSuggestions,
  serializeWikiSuggestionAddress,
  type AliasCandidate,
  type TitleCandidate,
  type WikiSuggestion,
} from './suggest'

function note(
  title: string,
  mtime = 0,
  extra?: Partial<TitleCandidate>,
): TitleCandidate {
  return {
    path: `notes/${title.toLowerCase().replaceAll(' ', '-')}.md`,
    title,
    titleKey: title.toLowerCase(),
    dailyDate: null,
    mtime,
    ...extra,
  }
}

function alias(target: TitleCandidate, aliasText: string): AliasCandidate {
  return { ...target, alias: aliasText, aliasKey: aliasText.toLowerCase() }
}

describe('rankWikiSuggestions', () => {
  it('orders exact before prefix before substring', () => {
    const result = rankWikiSuggestions(
      'meet',
      [note('Comeet Notes', 30), note('Meetings', 20), note('Meet', 10)],
      [],
      8,
    )
    expect(result.map((s) => s.title)).toEqual(['Meet', 'Meetings', 'Comeet Notes'])
  })

  it('ranks a title hit ahead of an alias hit of the same strength', () => {
    const viaAlias = alias(note('Acme Corp', 99), 'meetco')
    const result = rankWikiSuggestions('meetco', [note('Meetco', 1)], [viaAlias], 8)
    expect(result.map((s) => s.title)).toEqual(['Meetco', 'Acme Corp'])
    expect(result[1]!.alias).toBe('meetco')
  })

  it('ties break on recency, then title', () => {
    const result = rankWikiSuggestions(
      'pro',
      [note('Project Old', 1), note('Project New', 2), note('Apro B', 2, { titleKey: 'apro b' })],
      [],
      8,
    )
    // Both prefix hits beat the substring hit; newer prefix hit first.
    expect(result.map((s) => s.title)).toEqual(['Project New', 'Project Old', 'Apro B'])
  })

  it('dedupes a note matched by both title and alias, keeping the better row', () => {
    const target = note('Roadmap', 5)
    const result = rankWikiSuggestions('roadmap', [target], [alias(target, 'roadmap 2026')], 8)
    expect(result).toHaveLength(1)
    expect(result[0]!.alias).toBeNull() // the exact title row won
  })

  it('an empty key is a recency feed (no match ranking)', () => {
    const result = rankWikiSuggestions('', [note('Old', 1), note('New', 9)], [], 8)
    expect(result.map((s) => s.title)).toEqual(['New', 'Old'])
  })

  it('daily rows target their date, not their title', () => {
    const daily = note('2026-06-09', 1, { dailyDate: '2026-06-09' })
    const result = rankWikiSuggestions('2026', [daily], [], 8)
    expect(result[0]!.target).toBe('2026-06-09')
    expect(result[0]!.date).toBe('2026-06-09')
  })

  it('honours the limit after merging', () => {
    const titles = Array.from({ length: 10 }, (_, i) => note(`Note ${i}`, i))
    expect(rankWikiSuggestions('note', titles, [], 3)).toHaveLength(3)
  })
})

describe('isWikiLinkSafeText', () => {
  it('accepts ordinary title text', () => {
    expect(isWikiLinkSafeText('Meeting with Ada')).toBe(true)
    expect(isWikiLinkSafeText('')).toBe(true)
  })

  it('rejects every character that would corrupt a link, backslash included', () => {
    for (const text of ['a[b', 'a]b', 'a|b', 'a\\b', 'a\rb', 'a\nb']) {
      expect(isWikiLinkSafeText(text)).toBe(false)
    }
  })
})

describe('wiki suggestion serialization', () => {
  it('preserves an alias as display text while targeting the canonical note', () => {
    const suggestion = rankWikiSuggestions(
      'dad',
      [],
      [alias(note('Tim MacCaw // Dad'), 'Dad')],
      8,
    )[0]!

    const insertText = serializeWikiSuggestionAddress(
      suggestion.target,
      suggestion.alias,
    )
    expect(insertText).toBe('Tim MacCaw // Dad|Dad')
    expect(parseNote({ path: 'notes/source.md', source: `[[${insertText}]]` }).wikiLinks).toEqual([
      expect.objectContaining({ target: 'Tim MacCaw // Dad', alias: 'Dad' }),
    ])
  })

  it('round-trips every accepted target and display value exactly', () => {
    const accepted = [
      { target: 'Road.map!', display: null },
      { target: 'Tim MacCaw // Dad', display: 'D.ad!?' },
      { target: 'Café — plans', display: '計画' },
    ]
    for (const { target, display } of accepted) {
      const insertText = serializeWikiSuggestionAddress(target, display)
      expect(insertText).not.toBeNull()
      const links = parseNote({
        path: 'notes/source.md',
        source: `[[${insertText}]]`,
      }).wikiLinks
      expect(links).toHaveLength(1)
      expect(links[0]!.target).toBe(target)
      expect(links[0]!.alias ?? null).toBe(display)
    }
  })

  it('rejects every unescaped wiki-link delimiter in targets and display text', () => {
    for (const reserved of ['[', ']', '|', '\\', '\r', '\n']) {
      expect(serializeWikiSuggestionAddress(`Road${reserved}map`, null)).toBeNull()
      expect(serializeWikiSuggestionAddress('Roadmap', `Plan${reserved}`)).toBeNull()
    }
  })

  it('rejects a blank target rather than inserting an empty link', () => {
    expect(serializeWikiSuggestionAddress('   ', null)).toBeNull()
  })
})

function ranked(
  title: string,
  extra?: Partial<WikiSuggestion>,
): WikiSuggestion {
  return {
    target: title,
    path: `notes/${title.toLowerCase().replaceAll(' ', '-')}.md`,
    title,
    alias: null,
    date: null,
    ...extra,
  }
}

describe('mergeDateSuggestions', () => {
  it('passes ranked through untouched when there are no dates', () => {
    const rows = [ranked('Alpha'), ranked('Beta')]
    expect(mergeDateSuggestions(rows, [], { key: 'al', limit: 8 })).toEqual(rows)
  })

  it('leads with date suggestions ahead of non-exact matches', () => {
    const result = mergeDateSuggestions(
      [ranked('Monday Standup')],
      [{ date: '2020-01-06', phrase: 'This Monday' }],
      { key: 'mon', limit: 8 },
    )
    expect(result.map((row) => row.target)).toEqual(['2020-01-06', 'Monday Standup'])
    expect(result[0]).toMatchObject({
      date: '2020-01-06',
      generated: { phrase: 'This Monday' },
      path: null,
    })
  })

  it('keeps an exact title match in the very top slot, dates next', () => {
    const result = mergeDateSuggestions(
      [ranked('Today'), ranked('Today Notes')],
      [{ date: '2020-01-01', phrase: 'Today' }],
      { key: 'today', limit: 8 },
    )
    expect(result.map((row) => row.target)).toEqual(['Today', '2020-01-01', 'Today Notes'])
  })

  it('reuses an existing daily row (real path) and marks it generated once', () => {
    const existingDaily = ranked('2020-01-06', {
      target: '2020-01-06',
      path: 'daily/2020-01-06.md',
      date: '2020-01-06',
    })
    const result = mergeDateSuggestions(
      [existingDaily, ranked('Other')],
      [{ date: '2020-01-06', phrase: 'This Monday' }],
      { key: 'mon', limit: 8 },
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      path: 'daily/2020-01-06.md',
      generated: { phrase: 'This Monday' },
    })
    expect(result.map((row) => row.target)).toEqual(['2020-01-06', 'Other'])
  })

  it('a bare-ISO date is not marked generated', () => {
    const result = mergeDateSuggestions([], [{ date: '2026-06-19', phrase: null }], {
      key: '2026-06-19',
      limit: 8,
    })
    expect(result[0]!.generated).toBeUndefined()
  })

  it('honours the limit across dates plus matches', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ranked(`Note ${i}`))
    const result = mergeDateSuggestions(rows, [{ date: '2020-01-02', phrase: 'Tomorrow' }], {
      key: 'note',
      limit: 5,
    })
    expect(result).toHaveLength(5)
    expect(result[0]!.target).toBe('2020-01-02')
  })
})

describe('rankWikiSuggestions — rich titles', () => {
  const rich = note('Meeting with [[Ada Lovelace|Ada]]', 0, {
    path: 'notes/meeting.md',
  })

  it('targets the linkable form while the title stays raw', () => {
    const [row] = rankWikiSuggestions('meeting', [rich], [], 8)
    expect(row).toMatchObject({
      target: 'Meeting with Ada',
      title: 'Meeting with [[Ada Lovelace|Ada]]',
      alias: null,
    })
  })

  it('folds the derived alias row into a plain suggestion (no self-alias)', () => {
    const derived = alias(rich, 'Meeting with Ada')
    const [row] = rankWikiSuggestions('meeting with ada', [], [derived], 8)
    expect(row).toMatchObject({ target: 'Meeting with Ada', alias: null })
  })

  it('keeps a real alias as display text on a rich-title note', () => {
    const standup = alias(rich, 'Standup')
    const [row] = rankWikiSuggestions('standup', [], [standup], 8)
    expect(row).toMatchObject({ target: 'Meeting with Ada', alias: 'Standup' })
  })

  it('keeps an authored alias that differs from the target only by case', () => {
    const plain = note('Meeting with Ada', 0, { path: 'notes/meeting.md' })
    const authored = alias(plain, 'meeting with ada')
    const [row] = rankWikiSuggestions('meeting with ada', [], [authored], 8)
    expect(row).toMatchObject({ target: 'Meeting with Ada', alias: 'meeting with ada' })
  })
})

describe('mergeDateSuggestions — rich titles', () => {
  it('an exact raw-title hit keeps the top slot ahead of generated dates', () => {
    const [ranked] = rankWikiSuggestions(
      foldKey('3 days ago [[Trip]]'),
      [note('3 days ago [[Trip]]')],
      [],
      8,
    )
    const merged = mergeDateSuggestions(
      [ranked!],
      [{ date: '2026-07-14', phrase: '3 days ago' }],
      { key: foldKey('3 days ago [[Trip]]'), limit: 8 },
    )
    expect(merged[0]).toBe(ranked)
    expect(merged[1]).toMatchObject({ date: '2026-07-14' })
  })
})
