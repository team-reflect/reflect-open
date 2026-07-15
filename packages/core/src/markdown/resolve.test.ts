import { describe, expect, it, vi } from 'vitest'
import {
  normalizeWikiTarget,
  resolveWikiLink,
  resolveWikiLinkAsync,
  type AsyncWikiLookup,
  type WikiLookup,
} from './resolve'

describe('normalizeWikiTarget', () => {
  it('trims and case-folds, flagging daily-date targets', () => {
    expect(normalizeWikiTarget('  Project X ')).toEqual({ raw: 'Project X', key: 'project x' })
    expect(normalizeWikiTarget('2024-02-29')).toEqual({
      raw: '2024-02-29',
      key: '2024-02-29',
      date: '2024-02-29', // leap day — calendar-valid
    })
    expect(normalizeWikiTarget('2026-06-09')).toEqual({
      raw: '2026-06-09',
      key: '2026-06-09',
      date: '2026-06-09',
    })
  })

  it('does not flag impossible dates as dailies (shape alone is not enough)', () => {
    // A shape-only match would be suggested as a daily but click-create as a
    // regular note — the calendar check keeps every consumer consistent.
    expect(normalizeWikiTarget('2026-02-31').date).toBeUndefined()
    expect(normalizeWikiTarget('2026-13-01').date).toBeUndefined()
    expect(normalizeWikiTarget('2023-02-29').date).toBeUndefined() // not a leap year
    expect(normalizeWikiTarget('2026-00-10').date).toBeUndefined()
  })
})

describe('resolveWikiLink', () => {
  const lookup: WikiLookup = {
    byDate: (date) => (date === '2026-06-09' ? 'daily/2026-06-09.md' : undefined),
    byTitle: (key) => (key === 'project x' ? 'notes/project-x.md' : undefined),
    byAlias: (key) => (key === 'pjx' ? 'notes/project-x.md' : undefined),
    byBasename: (key) => (key === 'filename' ? 'Archive/filename.md' : undefined),
  }

  it('resolves by date, title, then alias', () => {
    expect(resolveWikiLink('2026-06-09', lookup)).toEqual({ kind: 'resolved', ref: 'daily/2026-06-09.md' })
    expect(resolveWikiLink('Project X', lookup)).toEqual({ kind: 'resolved', ref: 'notes/project-x.md' })
    expect(resolveWikiLink('pjx', lookup)).toEqual({ kind: 'resolved', ref: 'notes/project-x.md' })
    expect(resolveWikiLink('filename', lookup)).toEqual({ kind: 'resolved', ref: 'Archive/filename.md' })
  })

  it('returns the original text when unresolved', () => {
    expect(resolveWikiLink('Unknown Page', lookup)).toEqual({ kind: 'unresolved', text: 'Unknown Page' })
  })
})

describe('resolveWikiLinkAsync', () => {
  it('applies the same date → title → alias → basename precedence', async () => {
    const lookup: AsyncWikiLookup = {
      byDate: async (date) => (date === '2026-06-09' ? 'daily/2026-06-09.md' : undefined),
      byTitle: async (key) => (key === 'project x' ? 'notes/project-x.md' : undefined),
      byAlias: async (key) => (key === 'pjx' ? 'notes/project-x.md' : undefined),
      byBasename: async (key) =>
        key === 'filename' ? 'Archive/filename.md' : undefined,
    }
    expect(await resolveWikiLinkAsync('2026-06-09', lookup)).toEqual({
      kind: 'resolved',
      ref: 'daily/2026-06-09.md',
    })
    expect(await resolveWikiLinkAsync('Project X', lookup)).toEqual({
      kind: 'resolved',
      ref: 'notes/project-x.md',
    })
    expect(await resolveWikiLinkAsync('pjx', lookup)).toEqual({
      kind: 'resolved',
      ref: 'notes/project-x.md',
    })
    expect(await resolveWikiLinkAsync('filename', lookup)).toEqual({
      kind: 'resolved',
      ref: 'Archive/filename.md',
    })
    expect(await resolveWikiLinkAsync('Unknown', lookup)).toEqual({
      kind: 'unresolved',
      text: 'Unknown',
    })
  })

  it('short-circuits: a title hit never queries the alias lookup', async () => {
    const byAlias = vi.fn(async () => undefined)
    const lookup: AsyncWikiLookup = {
      byDate: async () => undefined,
      byTitle: async () => 'notes/hit.md',
      byAlias,
      byBasename: async () => undefined,
    }
    expect(await resolveWikiLinkAsync('Anything', lookup)).toEqual({
      kind: 'resolved',
      ref: 'notes/hit.md',
    })
    expect(byAlias).not.toHaveBeenCalled()
  })

  it('skips the date lookup for a non-date target', async () => {
    const byDate = vi.fn(async () => 'daily/should-not-be-used.md')
    const lookup: AsyncWikiLookup = {
      byDate,
      byTitle: async () => undefined,
      byAlias: async () => 'notes/alias.md',
      byBasename: async () => undefined,
    }
    expect(await resolveWikiLinkAsync('Some Title', lookup)).toEqual({
      kind: 'resolved',
      ref: 'notes/alias.md',
    })
    expect(byDate).not.toHaveBeenCalled()
  })
})
