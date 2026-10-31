import { describe, expect, it } from 'vitest'
import type { ContactMatch } from './commands.ts'
import { pickContactForEmail } from './resolve.ts'

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

describe('pickContactForEmail', () => {
  it('picks the candidate that owns the email, case-insensitively', () => {
    const ada = contact({ fullName: 'Ada Lovelace', emails: ['Ada@Example.com'] })
    expect(pickContactForEmail('ada@example.com', [ada])).toBe(ada)
  })

  it('rejects near matches that do not carry the exact address', () => {
    const other = contact({ fullName: 'Ada Lovelace', emails: ['ada@other.com'] })
    expect(pickContactForEmail('ada@example.com', [other])).toBeNull()
  })

  it('prefers a named owner over a nameless one', () => {
    const nameless = contact({ emails: ['ada@example.com'] })
    const named = contact({ fullName: 'Ada Lovelace', emails: ['ada@example.com'] })
    expect(pickContactForEmail('ada@example.com', [nameless, named])).toBe(named)
  })

  it('returns null for a blank email', () => {
    expect(pickContactForEmail('  ', [contact({ emails: [''] })])).toBeNull()
  })
})
