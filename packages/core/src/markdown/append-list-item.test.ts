import { describe, expect, it } from 'vitest'
import { appendListItem } from './append-list-item'

describe('appendListItem', () => {
  it('starts a list in an empty note', () => {
    expect(appendListItem('', 'call the bank', 'bullet')).toBe('- call the bank\n')
  })

  it('starts a fresh list one blank line after a prose tail', () => {
    expect(appendListItem('Some notes.\n', 'call the bank', 'bullet')).toBe(
      'Some notes.\n\n- call the bank\n',
    )
  })

  it('joins a trailing dash list without a blank line', () => {
    expect(appendListItem('- morning standup\n', 'call the bank', 'bullet')).toBe(
      '- morning standup\n- call the bank\n',
    )
  })

  it('adopts a trailing star list’s marker', () => {
    expect(appendListItem('* one\n* two\n', 'three', 'bullet')).toBe('* one\n* two\n* three\n')
  })

  it('adopts a trailing plus list’s marker for a plain bullet', () => {
    expect(appendListItem('+ [ ] buy milk\n', 'call the bank', 'bullet')).toBe(
      '+ [ ] buy milk\n+ call the bank\n',
    )
  })

  it('joins a checkbox to a dash list with the dash marker', () => {
    expect(appendListItem('- a\n', 'pack a bag', 'checkbox')).toBe('- a\n- [ ] pack a bag\n')
  })

  it('joins a checkbox to a star list with the star marker', () => {
    expect(appendListItem('* a\n', 'pack a bag', 'checkbox')).toBe('* a\n* [ ] pack a bag\n')
  })

  it('never writes a checkbox with the + marker — that line would be a task', () => {
    expect(appendListItem('+ [ ] buy milk\n', 'pack a bag', 'checkbox')).toBe(
      '+ [ ] buy milk\n\n- [ ] pack a bag\n',
    )
  })

  it('joins a task to a plus list', () => {
    expect(appendListItem('+ [ ] buy milk\n', 'water plants', 'task')).toBe(
      '+ [ ] buy milk\n+ [ ] water plants\n',
    )
  })

  it('keeps a task round after a dash list by starting its own block', () => {
    expect(appendListItem('- a\n', 'water plants', 'task')).toBe('- a\n\n+ [ ] water plants\n')
  })

  it('continues the outer list after a nested tail, including four-space markers', () => {
    const source = '- foo\n  - bar\n    - baz\n'
    expect(appendListItem(source, 'new item', 'bullet')).toBe(
      '- foo\n  - bar\n    - baz\n- new item\n',
    )
  })

  it('does not mistake an indented code block for a list', () => {
    const source = 'Some prose.\n\n    - not a list item\n'
    expect(appendListItem(source, 'call the bank', 'bullet')).toBe(
      'Some prose.\n\n    - not a list item\n\n- call the bank\n',
    )
  })

  it('does not join an ordered list', () => {
    expect(appendListItem('1. first\n', 'call the bank', 'bullet')).toBe(
      '1. first\n\n- call the bank\n',
    )
  })

  it('does not join a list inside a closed fence', () => {
    const source = '```\n- inside a fence\n```\n'
    expect(appendListItem(source, 'call the bank', 'bullet')).toBe(
      '```\n- inside a fence\n```\n\n- call the bank\n',
    )
  })

  it('does not join a list that a heading follows', () => {
    const source = '- old list\n\n## Later\n'
    expect(appendListItem(source, 'call the bank', 'bullet')).toBe(
      '- old list\n\n## Later\n\n- call the bank\n',
    )
  })

  it('inserts before trailing blank lines, preserving them', () => {
    expect(appendListItem('- a\n\n\n', 'b', 'bullet')).toBe('- a\n- b\n\n\n')
  })

  it('keeps CRLF line endings when joining', () => {
    expect(appendListItem('- a\r\n', 'b', 'bullet')).toBe('- a\r\n- b\r\n')
  })

  it('joins the trailing list of a note with frontmatter', () => {
    const source = '---\nfoo: 1\n---\n\n- a\n'
    expect(appendListItem(source, 'b', 'bullet')).toBe('---\nfoo: 1\n---\n\n- a\n- b\n')
  })

  it('starts a list after frontmatter-only content', () => {
    expect(appendListItem('---\nfoo: 1\n---\n', 'b', 'bullet')).toBe('---\nfoo: 1\n---\n\n- b\n')
  })

  it('trims the payload', () => {
    expect(appendListItem('- a\n', '  padded  ', 'bullet')).toBe('- a\n- padded\n')
  })
})
