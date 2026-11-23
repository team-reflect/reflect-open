import { describe, expect, it } from 'vitest'
import { appendListItem, linkSectionHeading } from './list-insert.ts'

describe('appendListItem', () => {
  const meetings = { titles: ['Meetings'], linked: false } as const
  const links = { titles: ['Links'], linked: true } as const

  it.each([
    ['', '- call the bank\n'],
    ['Some notes.\n', 'Some notes.\n\n- call the bank\n'],
    ['- morning standup\n', '- morning standup\n- call the bank\n'],
    ['* one\n* two\n', '* one\n* two\n* call the bank\n'],
    ['+ [ ] buy milk\n', '+ [ ] buy milk\n+ call the bank\n'],
    ['1. first\n', '1. first\n- call the bank\n'],
    ['- a\n\n\n', '- a\n- call the bank\n\n\n'],
    ['---\nfoo: 1\n---\n', '---\nfoo: 1\n---\n- call the bank\n'],
    ['---\nfoo: 1\n---\n\n- a\n', '---\nfoo: 1\n---\n\n- a\n- call the bank\n'],
  ])('appends a bullet to %j, joining a trailing bullet list', (source, expected) => {
    expect(appendListItem(source, { kind: 'bullet', markdown: ' call the bank ' })).toBe(expected)
  })

  it('writes a checkbox with the list marker, never with +', () => {
    expect(appendListItem('- a\n', { kind: 'checkbox', markdown: 'pack a bag' })).toBe(
      '- a\n- [ ] pack a bag\n',
    )
    expect(appendListItem('* a\n', { kind: 'checkbox', markdown: 'pack a bag' })).toBe(
      '* a\n* [ ] pack a bag\n',
    )
    expect(appendListItem('+ [ ] buy milk\n', { kind: 'checkbox', markdown: 'pack a bag' })).toBe(
      '+ [ ] buy milk\n- [ ] pack a bag\n',
    )
  })

  it.each([
    ['', '- Inbox\n  - hello\n'],
    ['- Inbox\n', '- Inbox\n  - hello\n'],
    ['- Inbox\n  - first\n', '- Inbox\n  - first\n  - hello\n'],
    ['- [[Inbox]]\n  - first\n', '- [[Inbox]]\n  - first\n  - hello\n'],
    ['- **inbox**\n', '- **inbox**\n  - hello\n'],
    ['- [[Inbox|My inbox]]\n', '- [[Inbox|My inbox]]\n  - hello\n'],
    ['+ Inbox\n  - first\n', '+ Inbox\n  - first\n  - hello\n'],
    ['- Inbox\n- Other\n- Inbox\n', '- Inbox\n  - hello\n- Other\n- Inbox\n'],
    ['## Today\n\n- Inbox\n\nprose\n', '## Today\n\n- Inbox\n  - hello\n\nprose\n'],
    ['- Inbox 2026\n', '- Inbox 2026\n- Inbox\n  - hello\n'],
    ['- [ ] Inbox\n', '- [ ] Inbox\n- Inbox\n  - hello\n'],
    ['- Work\n  - Inbox\n', '- Work\n  - Inbox\n- Inbox\n  - hello\n'],
    ['# Inbox\n', '# Inbox\n\n- Inbox\n  - hello\n'],
    ['notes\n\n\n', 'notes\n\n- Inbox\n  - hello\n\n\n'],
  ])('nests a bullet under the Inbox parent of %j', (source, expected) => {
    expect(appendListItem(source, { kind: 'bullet', markdown: 'hello', parent: 'Inbox' })).toBe(
      expected,
    )
  })

  it('creates a missing parent as the user typed it', () => {
    expect(
      appendListItem('- a\n', { kind: 'bullet', markdown: 'hello', parent: '[[Inbox]]' }),
    ).toBe('- a\n- [[Inbox]]\n  - hello\n')
  })

  it('creates a missing parent unfolded after a folded bullet', () => {
    expect(
      appendListItem('+ folded\n', { kind: 'bullet', markdown: 'hello', parent: 'Inbox' }),
    ).toBe('+ folded\n- Inbox\n  - hello\n')
  })

  it('ignores a blank parent', () => {
    expect(appendListItem('- a\n', { kind: 'bullet', markdown: 'hello', parent: '  ' })).toBe(
      '- a\n- hello\n',
    )
  })

  it('keeps a task round, so it joins only a + list', () => {
    expect(appendListItem('+ [ ] buy milk\n', { kind: 'task', markdown: 'water plants' })).toBe(
      '+ [ ] buy milk\n+ [ ] water plants\n',
    )
    expect(appendListItem('- a\n', { kind: 'task', markdown: 'water plants' })).toBe(
      '- a\n+ [ ] water plants\n',
    )
  })

  it.each([
    [
      '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n\nNotes for next time.\n\n- Personal reminder\n',
      '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n- [[Standup]]\n\nNotes for next time.\n\n- Personal reminder\n',
    ],
    [
      '## Meetings\n\nNotes for next time.\n',
      '## Meetings\n\n- [[Standup]]\n\nNotes for next time.\n',
    ],
    ['## Meetings\n\n* [[Kickoff]]\n', '## Meetings\n\n* [[Kickoff]]\n* [[Standup]]\n'],
    [
      '## Meetings\n\nAgenda I typed this morning:\n\n- [[Kickoff]]\n',
      '## Meetings\n\nAgenda I typed this morning:\n\n- [[Kickoff]]\n- [[Standup]]\n',
    ],
    [
      '## Meetings\n\nAgenda:\n\n### Follow-ups\n\n- [[Chase invoice]]\n',
      '## Meetings\n\n- [[Standup]]\n\nAgenda:\n\n### Follow-ups\n\n- [[Chase invoice]]\n',
    ],
    ['## Meetings\n\n1. Standup\n', '## Meetings\n\n- [[Standup]]\n1. Standup\n'],
    ['# meetings\n\nprose\n', '# meetings\n\n- [[Standup]]\n\nprose\n'],
    ['morning notes\n', 'morning notes\n\n## Meetings\n\n- [[Standup]]\n'],
    ['morning notes\n\n\n', 'morning notes\n\n## Meetings\n\n- [[Standup]]\n\n\n'],
    [
      '> ## Meetings\n> - [[Quoted]]\n\nOutside the quote.\n',
      '> ## Meetings\n>\n> - [[Quoted]]\n\nOutside the quote.\n\n## Meetings\n\n- [[Standup]]\n',
    ],
  ])('files a bullet in the section of %j', (source, expected) => {
    expect(
      appendListItem(source, { kind: 'bullet', markdown: '[[Standup]]', section: meetings }),
    ).toBe(expected)
  })

  it.each([
    ['morning notes\n', 'morning notes\n\n## [[Links]]\n\n- [[New]]\n'],
    ['## [[Links]]\n\n- [[Old]]\n', '## [[Links]]\n\n- [[Old]]\n- [[New]]\n'],
    [
      '## [[LINKS|Saved links]]\n\n- [[Old]]\n',
      '## [[LINKS|Saved links]]\n\n- [[Old]]\n- [[New]]\n',
    ],
    ['## Links\n\n- [[Old]]\n', '## [[Links]]\n\n- [[Old]]\n- [[New]]\n'],
    [
      '---\nprivate: true\n---\n\n## Links\n\n- [[Old]]\n\nScratchpad.\n',
      '---\nprivate: true\n---\n\n## [[Links]]\n\n- [[Old]]\n- [[New]]\n\nScratchpad.\n',
    ],
    [
      '## \\[[Links]]\n\nliteral brackets\n',
      '## \\[[Links]]\n\nliteral brackets\n\n## [[Links]]\n\n- [[New]]\n',
    ],
    [
      '- ## [[Links]]\n  - [[Nested]]\n\nOutside the list.\n',
      '- ## [[Links]]\n\n  - [[Nested]]\n\nOutside the list.\n\n## [[Links]]\n\n- [[New]]\n',
    ],
  ])(
    'files a bullet in the linked section of %j, linking a plain heading in place',
    (source, expected) => {
      expect(appendListItem(source, { kind: 'bullet', markdown: '[[New]]', section: links })).toBe(
        expected,
      )
    },
  )

  it('normalizes layout the serializer owns while appending', () => {
    expect(
      appendListItem('- p\n    - c\n        + [ ] t\n', { kind: 'bullet', markdown: 'x' }),
    ).toBe('- p\n  - c\n    + [ ] t\n- x\n')
  })
})

describe('linkSectionHeading', () => {
  const links = { titles: ['Links'], linked: true } as const

  it('links a plain heading and leaves a linked or missing one alone', () => {
    expect(linkSectionHeading('## Links\n\n- [[Old]]\n', links)).toBe('## [[Links]]\n\n- [[Old]]\n')
    const linked = '## [[Links|Saved]]\n\n- [[Old]]\n'
    expect(linkSectionHeading(linked, links)).toBe(linked)
    expect(linkSectionHeading('prose\n', links)).toBe('prose\n')
  })
})
