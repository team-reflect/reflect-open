import { describe, expect, it } from 'vitest'
import { appendBlock, clearTaskDueDate, setTaskDueDate } from './edit.ts'

describe('appendBlock', () => {
  it('appends one blank line after the existing content', () => {
    expect(appendBlock('alpha\n', 'new text')).toBe('alpha\n\nnew text\n')
  })

  it('collapses extra trailing whitespace to the single separator', () => {
    expect(appendBlock('alpha\n\n\n', 'new text')).toBe('alpha\n\nnew text\n')
  })

  it('becomes the whole body of an empty note', () => {
    expect(appendBlock('', 'new text')).toBe('new text\n')
    expect(appendBlock('\n', 'new text')).toBe('new text\n')
  })

  it('appends after frontmatter when the note has nothing else', () => {
    expect(appendBlock('---\nprivate: true\n---\n', 'new text')).toBe(
      '---\nprivate: true\n---\n\nnew text\n',
    )
  })

  it('trims the block itself', () => {
    expect(appendBlock('alpha', '  new text \n')).toBe('alpha\n\nnew text\n')
  })
})

describe('setTaskDueDate', () => {
  it('appends a due-date link to undated content', () => {
    expect(setTaskDueDate('buy milk', '2026-07-01')).toBe('buy milk [[2026-07-01]]')
  })

  it('becomes the whole content when it was empty', () => {
    expect(setTaskDueDate('', '2026-07-01')).toBe('[[2026-07-01]]')
  })

  it('replaces an existing due-date link, keeping the rest', () => {
    expect(setTaskDueDate('ship [[2026-06-01]] #release', '2026-07-01')).toBe(
      'ship [[2026-07-01]] #release',
    )
  })

  it('replaces the first valid date link and drops its alias', () => {
    expect(setTaskDueDate('do [[2026-06-01|June 1]]', '2026-07-01')).toBe('do [[2026-07-01]]')
  })

  it('ignores a non-date wiki link and appends instead', () => {
    expect(setTaskDueDate('see [[Project]]', '2026-07-01')).toBe('see [[Project]] [[2026-07-01]]')
  })

  it('skips an impossible date and appends a fresh one', () => {
    // [[2026-02-31]] isn't a real day, so it isn't a due date — append, don't replace.
    expect(setTaskDueDate('plan [[2026-02-31]]', '2026-07-01')).toBe(
      'plan [[2026-02-31]] [[2026-07-01]]',
    )
  })
})

describe('clearTaskDueDate', () => {
  it('removes the due-date link and tidies the whitespace', () => {
    expect(clearTaskDueDate('ship [[2026-06-01]] #release')).toBe('ship #release')
  })

  it('leaves content without a due date untouched', () => {
    expect(clearTaskDueDate('see [[Project]]')).toBe('see [[Project]]')
  })

  it('empties content that was only a due date', () => {
    expect(clearTaskDueDate('[[2026-06-01]]')).toBe('')
  })
})
