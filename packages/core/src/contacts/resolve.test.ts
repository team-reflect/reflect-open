import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import type { ContactMatch } from './commands'
import { pickContactForEmail, resolveAttendeeContact } from './resolve'

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

describe('resolveAttendeeContact', () => {
  it('short-circuits blank emails without touching the bridge', async () => {
    const invoke = vi.fn()
    setBridge({ invoke, listen: async () => () => {} })
    await expect(resolveAttendeeContact(' ')).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('looks up the trimmed email and applies the ownership rule', async () => {
    const invoke = vi.fn().mockResolvedValue([
      {
        fullName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        emails: ['ada@example.com'],
        phones: [],
      },
    ])
    setBridge({ invoke, listen: async () => () => {} })

    const match = await resolveAttendeeContact(' ada@example.com ')
    expect(match?.fullName).toBe('Ada Lovelace')
    expect(invoke).toHaveBeenCalledWith('contacts_lookup_by_email', {
      email: 'ada@example.com',
    })
  })

  it('resolves null on a miss (the flow then creates a bare person note)', async () => {
    setBridge({ invoke: async () => [], listen: async () => () => {} })
    await expect(resolveAttendeeContact('nobody@example.com')).resolves.toBeNull()
  })
})
