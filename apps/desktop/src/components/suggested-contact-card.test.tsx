import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestCoreServices,
  createTestContactsService,
  createTestNoteFileService,
  type TestContactsService,
  type TestNoteFileService,
} from '@reflect/core/testing'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { SuggestedContactCard } from './suggested-contact-card.tsx'

const PATH = 'notes/Ada Lovelace.md'

const ADA = {
  fullName: 'Ada Lovelace',
  givenName: 'Ada',
  familyName: 'Lovelace',
  emails: ['ada@example.com'],
  phones: ['+1 555 0100'],
}

let noteFile: TestNoteFileService
let contacts: TestContactsService

/**
 * Render the card with the contacts integration switched on or off.
 */
async function renderCard(contactsEnabled = true): Promise<void> {
  await renderInApp(<SuggestedContactCard path={PATH} />, {
    app: createTestCoreServices({ database: createWasmTestDatabaseService(), noteFile, contacts }),
    // The card writes with the generation of the open graph.
    graph: { root: '/g', generation: 3 },
    settings: { contactsEnabled },
  })
}

beforeEach(() => {
  noteFile = createTestNoteFileService()
  noteFile.set(PATH, '# Ada Lovelace\n')
  contacts = createTestContactsService({ contacts: [ADA] })
})

describe('SuggestedContactCard', () => {
  it('offers the matched contact with its primary details', async () => {
    await renderCard()
    await expect.element(page.getByText('Ada Lovelace')).toBeInTheDocument()
    await expect.element(page.getByText('ada@example.com · +1 555 0100')).toBeInTheDocument()
    expect(contacts.lookups()).toEqual([{ kind: 'name', name: 'Ada Lovelace' }])
  })

  it('Add writes the details block in one write, then the content hides the card', async () => {
    await renderCard()
    await userEvent.click(page.getByRole('button', { name: 'Add' }))

    await vi.waitFor(() => expect(noteFile.writes()).toHaveLength(1))
    expect(noteFile.getWrites(PATH)).toEqual([
      '# Ada Lovelace\n\n- Type: #person\n- Email: ada@example.com\n- Phone: +1 555 0100\n',
    ])
    await expectLocatorToHaveCount(page.getByText('Ada Lovelace'), 0)
  })

  it('Ignore records the contact in ignoredContacts, then hides the card', async () => {
    await renderCard()
    await userEvent.click(page.getByRole('button', { name: 'Ignore' }))

    await vi.waitFor(() => expect(noteFile.writes()).toHaveLength(1))
    expect(noteFile.getWrites(PATH)).toEqual([
      '---\nignoredContacts:\n  - Ada Lovelace\n---\n\n# Ada Lovelace\n',
    ])
    await expectLocatorToHaveCount(page.getByText('Ada Lovelace'), 0)
  })

  it('renders nothing when the body already carries contact details — no lookup', async () => {
    noteFile.set(PATH, '# Ada Lovelace\n\n- Email: ada@example.com\n')
    await renderCard()
    await vi.waitFor(() => expect(contacts.lookups()).toEqual([]))
    expect(page.getByText('Ada Lovelace').query()).toBeNull()
  })

  it('renders nothing for a contact dismissed on this note', async () => {
    noteFile.set(PATH, '---\nignoredContacts:\n  - ada lovelace\n---\n# Ada Lovelace\n')
    await renderCard()
    // The dismissal check needs the match's name, so the lookup does run.
    await vi.waitFor(() =>
      expect(contacts.lookups()).toEqual([{ kind: 'name', name: 'Ada Lovelace' }]),
    )
    expect(page.getByText('ada@example.com · +1 555 0100').query()).toBeNull()
  })

  it('renders nothing when the integration is off', async () => {
    await renderCard(false)
    await vi.waitFor(() => expect(contacts.lookups()).toEqual([]))
    expect(page.getByText('Ada Lovelace').query()).toBeNull()
  })

  it('renders nothing while contacts access is denied', async () => {
    contacts.setStatus('denied')
    await renderCard()
    await vi.waitFor(() => expect(contacts.lookups()).toEqual([]))
    expect(page.getByText('Ada Lovelace').query()).toBeNull()
  })
})
