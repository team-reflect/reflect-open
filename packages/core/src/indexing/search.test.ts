import { describe, expect, it } from 'vitest'
import { HIGHLIGHT_END, HIGHLIGHT_START, parseHighlights } from './search'

const mark = (text: string): string => `${HIGHLIGHT_START}${text}${HIGHLIGHT_END}`

describe('parseHighlights', () => {
  it('splits a snippet into plain and highlighted runs', () => {
    expect(parseHighlights(`…notes about ${mark('rust')} and ${mark('sqlite')} here`)).toEqual([
      { text: '…notes about ', highlighted: false },
      { text: 'rust', highlighted: true },
      { text: ' and ', highlighted: false },
      { text: 'sqlite', highlighted: true },
      { text: ' here', highlighted: false },
    ])
  })

  it('handles snippets with no matches and empty input', () => {
    expect(parseHighlights('plain text')).toEqual([{ text: 'plain text', highlighted: false }])
    expect(parseHighlights('')).toEqual([])
  })

  it('handles a snippet that is one whole match', () => {
    expect(parseHighlights(mark('everything'))).toEqual([{ text: 'everything', highlighted: true }])
  })
})
