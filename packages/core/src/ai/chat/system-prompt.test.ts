import { describe, expect, it } from 'vitest'
import { cloudSafeGraphContext, type CloudGraphContext } from '../checkers'
import { chatSystemPrompt } from './system-prompt'

function context(overrides: Partial<CloudGraphContext> = {}) {
  return cloudSafeGraphContext({
    graphName: 'atlas-graph',
    noteCount: 12,
    dailyNoteCount: 4,
    earliestDailyDate: '2026-01-02',
    latestDailyDate: '2026-06-10',
    tags: [
      { tag: 'Book', count: 3 },
      { tag: 'health', count: 1 },
    ],
    tagsTruncated: false,
    ...overrides,
  })
}

describe('chatSystemPrompt', () => {
  it('renders the date and grounding rules without an overview when context is null', () => {
    const prompt = chatSystemPrompt({ today: '2026-06-12', context: null })
    expect(prompt).toContain('Today’s date is 2026-06-12.')
    expect(prompt).toContain('Grounding rules:')
    expect(prompt).not.toContain('Graph overview')
  })

  it('steers the model away from redundant searches and serial reads', () => {
    const prompt = chatSystemPrompt({ today: '2026-06-12', context: null })
    expect(prompt).toContain('Search matches by meaning, not exact keywords')
    expect(prompt).toContain('raise search_notes’ “limit” (up to 20) in one call')
    expect(prompt).toContain('read them in the same round')
    expect(prompt).toContain('limited number of tool rounds')
  })

  it('renders the graph name, sizes, daily span, and the full tag vocabulary', () => {
    const prompt = chatSystemPrompt({ today: '2026-06-12', context: context() })
    expect(prompt).toContain('Graph overview (private notes are excluded from every figure):')
    expect(prompt).toContain('“atlas-graph” — 12 notes and 4 daily notes')
    expect(prompt).toContain('Daily notes span 2026-01-02 to 2026-06-10.')
    expect(prompt).toContain('#Book (3), #health (1)')
    // The complete list is asserted as complete, so the model never guesses.
    expect(prompt).toContain('These are the only tags')
  })

  it('softens the tag claim when the facet list was capped', () => {
    const prompt = chatSystemPrompt({
      today: '2026-06-12',
      context: context({ tagsTruncated: true }),
    })
    expect(prompt).toContain('Most-used tags')
    expect(prompt).toContain('More tags exist beyond these.')
    expect(prompt).not.toContain('These are the only tags')
  })

  it('tells the model outright when no tags exist', () => {
    const prompt = chatSystemPrompt({ today: '2026-06-12', context: context({ tags: [] }) })
    expect(prompt).toContain('No tags are in use — never pass a tag filter.')
  })

  it('omits the daily span when the graph has no daily notes', () => {
    const prompt = chatSystemPrompt({
      today: '2026-06-12',
      context: context({ dailyNoteCount: 0, earliestDailyDate: null, latestDailyDate: null }),
    })
    expect(prompt).toContain('0 daily notes')
    expect(prompt).not.toContain('Daily notes span')
  })
})
