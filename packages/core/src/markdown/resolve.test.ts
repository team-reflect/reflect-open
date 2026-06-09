import { describe, expect, it } from 'vitest'
import { normalizeWikiTarget, resolveWikiLink, type WikiLookup } from './resolve'

describe('normalizeWikiTarget', () => {
  it('trims and case-folds, flagging daily-date targets', () => {
    expect(normalizeWikiTarget('  Project X ')).toEqual({ raw: 'Project X', key: 'project x' })
    expect(normalizeWikiTarget('2026-06-09')).toEqual({
      raw: '2026-06-09',
      key: '2026-06-09',
      date: '2026-06-09',
    })
  })
})

describe('resolveWikiLink', () => {
  const lookup: WikiLookup = {
    byDate: (date) => (date === '2026-06-09' ? 'daily/2026-06-09.md' : undefined),
    byTitle: (key) => (key === 'project x' ? 'notes/project-x.md' : undefined),
    byAlias: (key) => (key === 'pjx' ? 'notes/project-x.md' : undefined),
  }

  it('resolves by date, title, then alias', () => {
    expect(resolveWikiLink('2026-06-09', lookup)).toEqual({ kind: 'resolved', ref: 'daily/2026-06-09.md' })
    expect(resolveWikiLink('Project X', lookup)).toEqual({ kind: 'resolved', ref: 'notes/project-x.md' })
    expect(resolveWikiLink('pjx', lookup)).toEqual({ kind: 'resolved', ref: 'notes/project-x.md' })
  })

  it('returns the original text when unresolved', () => {
    expect(resolveWikiLink('Unknown Page', lookup)).toEqual({ kind: 'unresolved', text: 'Unknown Page' })
  })
})
