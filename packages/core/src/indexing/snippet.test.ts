import { describe, expect, it } from 'vitest'
import { lineSnippet, previewSnippet } from './snippet'

describe('lineSnippet', () => {
  it('returns the whole line containing the position', () => {
    const content = 'first line\nsee [[Target]] here\nlast line\n'
    expect(lineSnippet(content, content.indexOf('[[Target]]'))).toBe('see [[Target]] here')
  })

  it('handles a position on the first and last lines', () => {
    const content = 'alpha [[X]]\nomega [[Y]]'
    expect(lineSnippet(content, content.indexOf('[[X]]'))).toBe('alpha [[X]]')
    expect(lineSnippet(content, content.indexOf('[[Y]]'))).toBe('omega [[Y]]')
  })

  it('windows a long line around the position, keeping the link visible', () => {
    const left = 'a'.repeat(300)
    const right = 'b'.repeat(300)
    const content = `${left} [[Target]] ${right}`
    const snippet = lineSnippet(content, content.indexOf('[[Target]]'), 80)
    expect(snippet).toContain('[[Target]]')
    expect(snippet.length).toBeLessThanOrEqual(82) // window + ellipses
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('keeps the link visible on long indented lines', () => {
    const content = `${' '.repeat(120)}[[Target]] ${'x'.repeat(240)}`
    const snippet = lineSnippet(content, content.indexOf('[[Target]]'), 80)
    expect(snippet).toContain('[[Target]]')
  })

  it('clamps an out-of-range position instead of throwing', () => {
    expect(lineSnippet('only line', 999)).toBe('only line')
    expect(lineSnippet('', 5)).toBe('')
  })
})

describe('previewSnippet', () => {
  // The indexer's plain text is whitespace-collapsed (`buildPlainText`), so
  // realistic input is one long line that opens with the note's title.
  it('drops the leading title from collapsed plain text', () => {
    expect(previewSnippet('Roadmap Ship the alpha in June. More.', 'Roadmap')).toBe(
      'Ship the alpha in June. More.',
    )
  })

  it('keeps text that does not open with the title (untitled notes)', () => {
    expect(previewSnippet('Just a thought. Second thought.', 'ulid-derived')).toBe(
      'Just a thought. Second thought.',
    )
  })

  it('only strips the title at a word boundary, never a mere prefix', () => {
    expect(previewSnippet('Healthy habits compound.', 'Health')).toBe(
      'Healthy habits compound.',
    )
  })

  it('keeps a repeated title beyond the leading occurrence', () => {
    expect(previewSnippet('Echo Echo', 'Echo')).toBe('Echo')
  })

  it('collapses raw multi-line input the same way the indexer does', () => {
    expect(previewSnippet('Title\n\n   \n\tbody at last', 'Title')).toBe('body at last')
    expect(previewSnippet('A  title\nwith   gaps', 'A title')).toBe('with gaps')
  })

  it('truncates long text with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const snippet = previewSnippet(long, 'Title', 50)
    expect(snippet).toBe(`${'x'.repeat(50)}…`)
  })

  it('returns empty for empty or title-only text', () => {
    expect(previewSnippet('', 'Title')).toBe('')
    expect(previewSnippet('Title', 'Title')).toBe('')
    expect(previewSnippet('Title\n', 'Title')).toBe('')
  })
})
