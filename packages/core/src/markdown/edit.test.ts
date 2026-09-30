import { describe, expect, it } from 'vitest'
import {
  appendBlock,
  appendListItemUnderBacklinkedHeading,
  appendListItemUnderHeading,
  clearTaskDueDate,
  setTaskDueDate,
} from './edit.ts'

describe('appendListItemUnderHeading', () => {
  it("extends the section's bullet list and stays before later prose and lists", () => {
    const source =
      '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n\nNotes for next time.\n\n- Personal reminder\n'
    expect(appendListItemUnderHeading(source, 'Meetings', '[[Standup]]')).toBe(
      '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n- [[Standup]]\n\nNotes for next time.\n\n- Personal reminder\n',
    )
  })

  it('starts a bullet list directly beneath the heading when prose comes first', () => {
    const source = '## Meetings\n\nNotes for next time.\n'
    expect(appendListItemUnderHeading(source, 'Meetings', '[[Standup]]')).toBe(
      '## Meetings\n\n- [[Standup]]\n\nNotes for next time.\n',
    )
  })

  it('reuses the list marker already in use', () => {
    const source = '## Meetings\n\n* [[Kickoff]]\n\nNotes for next time.\n'
    expect(appendListItemUnderHeading(source, 'Meetings', '[[Standup]]')).toBe(
      '## Meetings\n\n* [[Kickoff]]\n* [[Standup]]\n\nNotes for next time.\n',
    )
  })
  it('joins the list the section already has, even when prose comes first', () => {
    const source = '## Meetings\n\nAgenda I typed this morning:\n\n- [[Kickoff]]\n'
    expect(appendListItemUnderHeading(source, 'Meetings', '[[Standup]]')).toBe(
      '## Meetings\n\nAgenda I typed this morning:\n\n- [[Kickoff]]\n- [[Standup]]\n',
    )
  })

  it('starts its own list rather than joining one under a subheading', () => {
    const source = '## Meetings\n\nAgenda:\n\n### Follow-ups\n\n- [[Chase invoice]]\n'
    expect(appendListItemUnderHeading(source, 'Meetings', '[[Standup]]')).toBe(
      '## Meetings\n\n- [[Standup]]\n\nAgenda:\n\n### Follow-ups\n\n- [[Chase invoice]]\n',
    )
  })

  it('ignores an ordered list and starts an unordered one', () => {
    const source = '## Meetings\n\n1. Standup\n'
    expect(appendListItemUnderHeading(source, 'Meetings', '[[Standup]]')).toBe(
      '## Meetings\n\n- [[Standup]]\n\n1. Standup\n',
    )
  })
})

describe('appendListItemUnderBacklinkedHeading', () => {
  it('creates a linked H2 section when the category is missing', () => {
    expect(appendListItemUnderBacklinkedHeading('morning notes\n', 'Links', '[[Article]]')).toBe(
      'morning notes\n\n## [[Links]]\n\n- [[Article]]\n',
    )
  })

  it('matches a linked target case-insensitively and preserves its alias', () => {
    const source = '## [[LINKS|Saved links]]\n\n- [[Old]]\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '## [[LINKS|Saved links]]\n\n- [[Old]]\n- [[New]]\n',
    )
  })

  it('does not mistake escaped literal brackets for a linked heading', () => {
    const source = '## \\[[Links]]\n\nliteral brackets\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '## \\[[Links]]\n\nliteral brackets\n\n## [[Links]]\n\n- [[New]]\n',
    )
  })

  it('preserves a user-authored plain heading at another level', () => {
    const source = '# Links\n\ntitle-like content\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '# Links\n\ntitle-like content\n\n## [[Links]]\n\n- [[New]]\n',
    )
  })

  it('extends the list without crossing later prose or a subheading', () => {
    const source =
      '## [[Links]]\n\n- [[Old]]\n  - context\n- [[Older]]\n\nScratchpad.\n\n### Follow-up\n\ntext\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '## [[Links]]\n\n- [[Old]]\n  - context\n- [[Older]]\n- [[New]]\n\nScratchpad.\n\n### Follow-up\n\ntext\n',
    )
  })

  it('starts the list directly beneath the linked heading when prose comes first', () => {
    const source = '## [[Links]]\n\nScratchpad.\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '## [[Links]]\n\n- [[New]]\n\nScratchpad.\n',
    )
  })

  it('handles frontmatter offsets and upgrades a legacy heading in place', () => {
    const source = '---\nprivate: true\n---\n\n## Links\n\n- [[Old]]\n\nScratchpad.\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '---\nprivate: true\n---\n\n## [[Links]]\n\n- [[Old]]\n- [[New]]\n\nScratchpad.\n',
    )
  })

  it('preserves CRLF while inserting before prose', () => {
    const source = '## Links\r\n\r\n- [[Old]]\r\n\r\nScratchpad.\r\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '## [[Links]]\r\n\r\n- [[Old]]\r\n- [[New]]\r\n\r\nScratchpad.\r\n',
    )
  })

  it('preserves a nested matching heading and creates a top-level section', () => {
    const source = '> ## [[Links]]\n> - [[Quoted]]\n\nOutside the quote.\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '> ## [[Links]]\n> - [[Quoted]]\n\nOutside the quote.\n\n## [[Links]]\n\n- [[New]]\n',
    )
  })

  it('preserves a matching heading nested in a list item', () => {
    const source = '- ## [[Links]]\n  - [[Nested]]\n\nOutside the list.\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '- ## [[Links]]\n  - [[Nested]]\n\nOutside the list.\n\n## [[Links]]\n\n- [[New]]\n',
    )
  })

  it("joins a linked section's existing list from below its prose", () => {
    const source = '## [[Links]]\n\nReading list for today:\n\n- [[Old]]\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      '## [[Links]]\n\nReading list for today:\n\n- [[Old]]\n- [[New]]\n',
    )
  })

  it('uses CRLF when creating a missing section', () => {
    const source = 'Morning notes.\r\n'
    expect(appendListItemUnderBacklinkedHeading(source, 'Links', '[[New]]')).toBe(
      'Morning notes.\r\n\r\n## [[Links]]\r\n\r\n- [[New]]\r\n',
    )
  })
})

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

  it('preserves CRLF when appending a block', () => {
    expect(appendBlock('alpha\r\n', 'new text')).toBe('alpha\r\n\r\nnew text\r\n')
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
