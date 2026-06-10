import { describe, expect, it } from 'vitest'
import { lineSnippet } from './snippet'

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
