import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import type { ContactMatch } from './commands'
import { contactNamesEqual, matchContactForTitle, suggestContactForTitle } from './match'

function contact(overrides: Partial<ContactMatch>): ContactMatch {
  return {
    fullName: '',
    givenName: '',
    familyName: '',
    emails: [],
    phones: [],
    ...overrides,
  }
}

afterEach(() => {
  setBridge(null)
})

describe('matchContactForTitle', () => {
  it('matches a title that exactly equals a full name', () => {
    const ada = contact({ fullName: 'Ada Lovelace' })
    expect(matchContactForTitle('Ada Lovelace', [ada])).toBe(ada)
  })

  it('is case-insensitive and whitespace-collapsing', () => {
    const ada = contact({ fullName: 'Ada Lovelace' })
    expect(matchContactForTitle('  ada   lovelace ', [ada])).toBe(ada)
  })

  it('compares unicode-normalized names (composed vs decomposed accents)', () => {
    const rene = contact({ fullName: 'René Descartes' })
    expect(matchContactForTitle('René Descartes', [rene])).toBe(rene)
  })

  it('is diacritic-insensitive, matching the framework predicate that fed it', () => {
    const rene = contact({ fullName: 'René Descartes' })
    expect(matchContactForTitle('Rene Descartes', [rene])).toBe(rene)
    const zoe = contact({ fullName: 'Zoe Muller' })
    expect(matchContactForTitle('Zoë Müller', [zoe])).toBe(zoe)
  })

  it('rejects the word-prefix hits the framework predicate returns', () => {
    const ada = contact({ fullName: 'Ada Lovelace' })
    expect(matchContactForTitle('Ada', [ada])).toBeNull()
    expect(matchContactForTitle('Ada Lovelace Fan Club', [ada])).toBeNull()
  })

  it('never matches blank titles or nameless contacts', () => {
    const nameless = contact({ emails: ['x@example.com'] })
    expect(matchContactForTitle('', [nameless])).toBeNull()
    expect(matchContactForTitle('   ', [nameless])).toBeNull()
    expect(matchContactForTitle('x@example.com', [nameless])).toBeNull()
  })

  it('prefers the exact match carrying the most detail', () => {
    const empty = contact({ fullName: 'Ada Lovelace' })
    const detailed = contact({
      fullName: 'Ada Lovelace',
      emails: ['ada@example.com'],
      phones: ['+1 555 0100'],
    })
    expect(matchContactForTitle('Ada Lovelace', [empty, detailed])).toBe(detailed)
  })
})

describe('contactNamesEqual', () => {
  it('compares names under the matching rule (case, diacritics, whitespace)', () => {
    expect(contactNamesEqual('Ada Lovelace', 'ada  lovelace')).toBe(true)
    expect(contactNamesEqual('René Descartes', 'Rene Descartes')).toBe(true)
    expect(contactNamesEqual('Ada Lovelace', 'Grace Hopper')).toBe(false)
    expect(contactNamesEqual('', '')).toBe(false)
  })
})

describe('suggestContactForTitle', () => {
  it('short-circuits blank titles without touching the bridge', async () => {
    const invoke = vi.fn()
    setBridge({ invoke, listen: async () => () => {} })
    await expect(suggestContactForTitle('  ')).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('looks up the trimmed title and applies the exact-match rule', async () => {
    const invoke = vi.fn().mockResolvedValue([
      {
        fullName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        emails: ['ada@example.com'],
        phones: [],
      },
      { fullName: 'Ada Byron', givenName: 'Ada', familyName: 'Byron', emails: [], phones: [] },
    ])
    setBridge({ invoke, listen: async () => () => {} })

    const match = await suggestContactForTitle(' Ada Lovelace ')
    expect(match?.emails).toEqual(['ada@example.com'])
    expect(invoke).toHaveBeenCalledWith('contacts_lookup_by_name', { name: 'Ada Lovelace' })
  })
})
