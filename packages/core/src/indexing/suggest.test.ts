import { describe, expect, it } from 'vitest'
import { rankWikiSuggestions, type AliasCandidate, type TitleCandidate } from './suggest'

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
