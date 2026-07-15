import { describe, expect, it } from 'vitest'
import { isMarkdownNoteHref } from './attachment-reference'

describe('isMarkdownNoteHref', () => {
  it('recognizes Markdown note destinations before query strings and fragments', () => {
    expect(isMarkdownNoteHref('Plan.md?view=preview')).toBe(true)
    expect(isMarkdownNoteHref('Plan.MD?view=preview#Next')).toBe(true)
    expect(isMarkdownNoteHref('Plan%2Emd#Next')).toBe(true)
  })

  it('rejects attachment and malformed destinations', () => {
    expect(isMarkdownNoteHref('image.png?download=1')).toBe(false)
    expect(isMarkdownNoteHref('bad%2')).toBe(false)
  })
})
