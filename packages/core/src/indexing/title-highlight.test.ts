import { describe, expect, it } from 'vitest'
import { HIGHLIGHT_END, HIGHLIGHT_START, parseHighlights } from './search'
import { highlightTitle } from './title-highlight'

function segments(title: string, query: string, ftsHighlightedTitle: string | null = null) {
  return parseHighlights(highlightTitle(title, query, ftsHighlightedTitle))
}

describe('highlightTitle', () => {
  it('highlights a contiguous multi-term recall match without changing its casing', () => {
    expect(segments('Tim MacCaw', 'tim mac')).toEqual([
      { text: 'Tim Mac', highlighted: true },
      { text: 'Caw', highlighted: false },
    ])
  })

  it('highlights separate recall terms when the full phrase is absent', () => {
    expect(segments('MacCaw, Tim', 'tim mac')).toEqual([
      { text: 'Mac', highlighted: true },
      { text: 'Caw, ', highlighted: false },
      { text: 'Tim', highlighted: true },
    ])
  })

  it('only highlights space-delimited recall terms at title word starts', () => {
    expect(segments('Carpet Oscarpet', 'car')).toEqual([
      { text: 'Car', highlighted: true },
      { text: 'pet Oscarpet', highlighted: false },
    ])
    expect(segments('Oscarpet', 'car')).toEqual([
      { text: 'Oscarpet', highlighted: false },
    ])
  })

  it('highlights unsegmented-script recall terms anywhere in the title', () => {
    expect(segments('来週の東京旅行計画', '東京 旅行')).toEqual([
      { text: '来週の', highlighted: false },
      { text: '東京旅行', highlighted: true },
      { text: '計画', highlighted: false },
    ])
  })

  it('maps expanded lowercase text back to the original title', () => {
    expect(segments('İstanbul', 'i')).toEqual([
      { text: 'İ', highlighted: true },
      { text: 'stanbul', highlighted: false },
    ])
  })

  it('unions FTS token matches with title-recall matches', () => {
    const ftsTitle = `${HIGHLIGHT_START}Car${HIGHLIGHT_END}, ${HIGHLIGHT_START}car${HIGHLIGHT_END}`
    expect(segments('Car, car', 'car,', ftsTitle)).toEqual([
      { text: 'Car,', highlighted: true },
      { text: ' ', highlighted: false },
      { text: 'car', highlighted: true },
    ])
  })

  it('returns the plain title when neither source matched it', () => {
    expect(segments('Project notes', 'roadmap', 'Project notes')).toEqual([
      { text: 'Project notes', highlighted: false },
    ])
  })
})
