import { describe, expect, it } from 'vitest'
import { displayNoteTitle, wikiLinkTargetForTitle } from './note-title'

describe('displayNoteTitle', () => {
  it('renders inline links as their visible text', () => {
    expect(displayNoteTitle('Meeting with [[Ada Lovelace|Ada]] about [Notes](https://x.com)')).toBe(
      'Meeting with Ada about Notes',
    )
  })
})

describe('wikiLinkTargetForTitle', () => {
  it('keeps a plain title unchanged', () => {
    expect(wikiLinkTargetForTitle('Project Atlas')).toBe('Project Atlas')
  })

  it('turns a rich title into valid visible wiki-link text', () => {
    expect(wikiLinkTargetForTitle('Meeting with [[Ada Lovelace|Ada]]')).toBe('Meeting with Ada')
  })

  it('preserves titles without embedded wiki-link source byte-for-byte', () => {
    expect(wikiLinkTargetForTitle('Project  Atlas')).toBe('Project  Atlas')
    expect(wikiLinkTargetForTitle('[] |')).toBe('[] |')
  })

  it('normalizes embedded wiki-link source consistently across Markdown contexts', () => {
    expect(wikiLinkTargetForTitle('Code `[[Ada Lovelace|Ada]]`')).toBe('Code `Ada`')
    expect(wikiLinkTargetForTitle('<https://x.test/[[Ada Lovelace|Ada]]>')).toBe(
      '<https://x.test/Ada>',
    )
  })
})
