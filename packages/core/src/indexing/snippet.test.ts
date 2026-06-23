import { describe, expect, it } from 'vitest'
import { lineAt, lineSnippet, previewSnippet } from './snippet'

/** True when `text` contains a UTF-16 surrogate without its pair. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true
      }
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

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

describe('lineAt', () => {
  it('returns the whole trimmed line containing the position', () => {
    const content = 'first line\n   see [[Target]] here   \nlast line\n'
    expect(lineAt(content, content.indexOf('[[Target]]'))).toBe('see [[Target]] here')
  })

  it('returns the full line untruncated even when very long', () => {
    // A link past the 160-char window would be windowed (and possibly cut) by
    // lineSnippet; lineAt keeps the whole line so the [[…]] token stays balanced.
    const left = 'a'.repeat(300)
    const content = `${left} [[Target]] tail`
    const line = lineAt(content, content.indexOf('[[Target]]'))
    expect(line).toBe(`${left} [[Target]] tail`)
    expect(line).toContain('[[Target]]')
    expect(line.startsWith('…')).toBe(false)
  })

  it('picks the correct line for first, last, and out-of-range positions', () => {
    const content = 'alpha [[X]]\nomega [[Y]]'
    expect(lineAt(content, content.indexOf('[[X]]'))).toBe('alpha [[X]]')
    expect(lineAt(content, content.indexOf('[[Y]]'))).toBe('omega [[Y]]')
    expect(lineAt('only line', 999)).toBe('only line')
    expect(lineAt('', 5)).toBe('')
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

  it('never splits an astral character at the truncation boundary', () => {
    // 𝐒 (U+1D5D2) is a surrogate pair; a raw slice(0, 50) would cut it in half
    // and leave a lone high surrogate the Rust index writer's serde_json
    // rejects ("unexpected end of hex escape"), dropping the note from the index.
    const text = `${'x'.repeat(49)}𝐒𝐏𝐈𝐍 the rest is dropped`
    const snippet = previewSnippet(text, 'Title', 50)
    expect(hasLoneSurrogate(snippet)).toBe(false)
    expect(snippet).toBe(`${'x'.repeat(49)}…`)
  })

  it('keeps a whole astral character that fits within the limit', () => {
    const text = `${'x'.repeat(48)}𝐒 spilling well past the cap to force a cut`
    const snippet = previewSnippet(text, 'Title', 50)
    expect(hasLoneSurrogate(snippet)).toBe(false)
    expect(snippet).toBe(`${'x'.repeat(48)}𝐒…`)
  })

  it('returns empty for empty or title-only text', () => {
    expect(previewSnippet('', 'Title')).toBe('')
    expect(previewSnippet('Title', 'Title')).toBe('')
    expect(previewSnippet('Title\n', 'Title')).toBe('')
  })
})
