import { describe, expect, it, vi } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createContactsService } from './contacts-service.ts'

const ADA = {
  fullName: 'Ada Lovelace',
  givenName: 'Ada',
  familyName: 'Lovelace',
  emails: ['ada@example.com'],
  phones: [],
}
describe('createContactsService', () => {
  it('starts unread and adopts the permission state on refresh', async () => {
    let status = 'notDetermined'
    const ipc = createTestIpcBridgeService({
      commands: { contacts_authorization_status: () => status },
    })
    const contacts = createContactsService({ ipc, logger: createTestLoggerService() })
    const listener = vi.fn()
    contacts.subscribe(listener)
    expect(contacts.getState()).toEqual({ authorization: null })

    await contacts.refresh()
    const first = contacts.getState()
    expect(first).toEqual({ authorization: 'notDetermined' })
    await contacts.refresh()
    expect(contacts.getState()).toBe(first)
    status = 'authorized'
    await contacts.refresh()

    expect(contacts.getState()).toEqual({ authorization: 'authorized' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps the last state and warns when a refresh fails', async () => {
    const logger = createTestLoggerService()
    const ipc = createTestIpcBridgeService()
    const contacts = createContactsService({ ipc, logger })

    await expect(contacts.refresh()).resolves.toBeUndefined()

    expect(contacts.getState()).toEqual({ authorization: null })
    expect(logger.getWarnings().map((entry) => entry.message)).toEqual([
      'failed to read the contacts permission',
    ])
  })

  it('refreshes after a permission prompt', async () => {
    let status = 'notDetermined'
    const ipc = createTestIpcBridgeService({
      commands: {
        contacts_authorization_status: () => status,
        contacts_request_access: () => {
          status = 'denied'
          return false
        },
      },
    })
    const contacts = createContactsService({ ipc, logger: createTestLoggerService() })

    await expect(contacts.requestAccess()).resolves.toBe(false)

    expect(contacts.getState()).toEqual({ authorization: 'denied' })
  })

  it('opens the lookup gate only when enabled and readable', async () => {
    let status = 'authorized'
    const ipc = createTestIpcBridgeService({
      commands: { contacts_authorization_status: () => status },
    })
    const contacts = createContactsService({ ipc, logger: createTestLoggerService() })
    const ON = { contactsEnabled: true }
    expect(contacts.canLookup(ON)).toBe(false)

    await contacts.refresh()
    expect(contacts.canLookup(ON)).toBe(true)
    expect(contacts.canLookup({ contactsEnabled: false })).toBe(false)
    status = 'limited'
    await contacts.refresh()
    expect(contacts.canLookup(ON)).toBe(true)
    status = 'denied'
    await contacts.refresh()
    expect(contacts.canLookup(ON)).toBe(false)
  })

  it('looks people up by name, skipping one-letter queries and capping the rows', async () => {
    const people = ['Ada A', 'Ada B', 'Ada C', 'Ada D', 'Ada E'].map((fullName) => ({
      ...ADA,
      fullName,
      emails: [`${fullName.replace(' ', '.').toLowerCase()}@example.com`],
    }))
    const ipc = createTestIpcBridgeService({
      commands: { contacts_lookup_by_name: () => people },
    })
    const contacts = createContactsService({ ipc, logger: createTestLoggerService() })

    await expect(contacts.lookupPeople(' A ')).resolves.toEqual([])
    const found = await contacts.lookupPeople(' Ada ')

    expect(found).toHaveLength(4)
    expect(ipc.calls()).toEqual([{ command: 'contacts_lookup_by_name', args: { name: 'Ada' } }])
  })

  it('looks contacts up by email and by name', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        contacts_lookup_by_email: () => [ADA],
        contacts_lookup_by_name: () => [{ ...ADA, phones: 'odd' }],
      },
    })
    const contacts = createContactsService({ ipc, logger: createTestLoggerService() })

    await expect(contacts.lookupByEmail('ada@example.com')).resolves.toEqual([ADA])
    await expect(contacts.lookupByName('Ada')).resolves.toEqual([ADA])
    expect(ipc.calls()).toEqual([
      { command: 'contacts_lookup_by_email', args: { email: 'ada@example.com' } },
      { command: 'contacts_lookup_by_name', args: { name: 'Ada' } },
    ])
  })
})
