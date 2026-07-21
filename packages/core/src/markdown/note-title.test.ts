import { describe, expect, it } from 'vitest'
import { displayNoteTitle, wikiLinkTargetForTitle } from './note-title'

describe('displayNoteTitle', () => {
  it('flattens wiki links to their alias and markdown links to their text', () => {
    expect(
      displayNoteTitle('Meeting with [[Ada Lovelace|Ada]] about [Notes](https://x.com)'),
    ).toBe('Meeting with Ada about Notes')
  })

  it('uses the target when a wiki link has no alias', () => {
    expect(displayNoteTitle('Meeting with [[Ada Lovelace]]')).toBe(
      'Meeting with Ada Lovelace',
    )
  })
})

describe('wikiLinkTargetForTitle', () => {
  it('returns a trivial title byte-for-byte', () => {
    expect(wikiLinkTargetForTitle('Project Atlas')).toBe('Project Atlas')
  })

  it('flattens an aliased embedded link to its alias', () => {
    expect(wikiLinkTargetForTitle('Meeting with [[Ada Lovelace|Ada]]')).toBe(
      'Meeting with Ada',
    )
  })

  it('flattens an unaliased embedded link to its target', () => {
    expect(wikiLinkTargetForTitle('Meeting with [[Ada Lovelace]]')).toBe(
      'Meeting with Ada Lovelace',
    )
  })

  it('keeps a title with no complete embedded link byte-for-byte', () => {
    expect(wikiLinkTargetForTitle('Project  Atlas')).toBe('Project  Atlas')
    expect(wikiLinkTargetForTitle('[] |')).toBe('[] |')
    expect(wikiLinkTargetForTitle('[[never closed')).toBe('[[never closed')
  })

  it('flattens links in every markdown context, unlike the display form', () => {
    // The derived form must never retain `[[`, so the scan is deliberately
    // context-free: links inside code spans flatten too.
    expect(wikiLinkTargetForTitle('Code `[[Ada Lovelace|Ada]]`')).toBe('Code `Ada`')
  })

  it('falls back to the raw title when the derived form collapses to nothing', () => {
    expect(wikiLinkTargetForTitle('[[ [ ]]')).toBe('[[ [ ]]')
  })

  it('keeps a whitespace-only target literal (not a link)', () => {
    expect(wikiLinkTargetForTitle('A [[ ]] B')).toBe('A [[ ]] B')
  })

  it('display and target renderings may legitimately differ for one title', () => {
    const title = 'Code `[[Ada Lovelace|Ada]]`'
    expect(displayNoteTitle(title)).toBe('Code `[[Ada Lovelace|Ada]]`')
    expect(wikiLinkTargetForTitle(title)).toBe('Code `Ada`')
  })
})
