import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { SuggestedContactCard } from './suggested-contact-card'

// The card reads the graph (generation for writes) and the contacts opt-in;
// both providers are per-app plumbing the component test doesn't need.
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', generation: 3 } }),
}))
const contactsEnabled = vi.hoisted(() => ({ current: true }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { contactsEnabled: contactsEnabled.current } }),
}))

const ADA = {
  fullName: 'Ada Lovelace',
  givenName: 'Ada',
  familyName: 'Lovelace',
  emails: ['ada@example.com'],
  phones: ['+1 555 0100'],
}

let noteSource: string
let written: Array<{ path: string; contents: string }>
let lookups: string[]

function installFakeBridge(authorization = 'authorized'): void {
  written = []
  lookups = []
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'contacts_authorization_status':
          return authorization
        case 'contacts_lookup_by_name':
          lookups.push(String(args['name']))
          return [ADA]
        case 'note_read':
          return noteSource
        case 'note_write': {
          const path = String(args['path'])
          const contents = String(args['contents'])
          written.push({ path, contents })
          noteSource = contents
          return null
        }
        default:
          throw new Error(`unexpected command ${command}`)
      }
    },
    listen: async () => () => {},
  })
}

function renderCard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <SuggestedContactCard path="notes/Ada Lovelace.md" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  contactsEnabled.current = true
  noteSource = '# Ada Lovelace\n'
  installFakeBridge()
})

afterEach(() => {
  cleanup()
  setBridge(null)
})

describe('SuggestedContactCard', () => {
  it('offers the matched contact with its primary details', async () => {
    renderCard()
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy()
    expect(screen.getByText('ada@example.com · +1 555 0100')).toBeTruthy()
    expect(lookups).toEqual(['Ada Lovelace'])
  })

  it('Add writes the details block in one write, then the content hides the card', async () => {
    renderCard()
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(() => expect(written.length).toBe(1))
    expect(written[0]?.contents).toBe(
      '# Ada Lovelace\n\n- Type: #person\n- Email: ada@example.com\n- Phone: +1 555 0100\n',
    )
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).toBeNull())
  })

  it('Ignore records the contact in ignoredContacts, then hides the card', async () => {
    renderCard()
    await userEvent.click(await screen.findByRole('button', { name: 'Ignore' }))

    await waitFor(() => expect(written.length).toBe(1))
    expect(written[0]?.contents).toBe(
      '---\nignoredContacts:\n  - Ada Lovelace\n---\n# Ada Lovelace\n',
    )
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).toBeNull())
  })

  it('renders nothing when the body already carries contact details — no lookup', async () => {
    noteSource = '# Ada Lovelace\n\n- Email: ada@example.com\n'
    renderCard()
    await waitFor(() => expect(lookups).toEqual([]))
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
  })

  it('renders nothing for a contact dismissed on this note', async () => {
    noteSource = '---\nignoredContacts:\n  - ada lovelace\n---\n# Ada Lovelace\n'
    renderCard()
    // The dismissal check needs the match's name, so the lookup does run.
    await waitFor(() => expect(lookups).toEqual(['Ada Lovelace']))
    expect(screen.queryByText('ada@example.com · +1 555 0100')).toBeNull()
  })

  it('renders nothing when the integration is off', async () => {
    contactsEnabled.current = false
    renderCard()
    await waitFor(() => expect(lookups).toEqual([]))
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
  })

  it('renders nothing while contacts access is denied', async () => {
    installFakeBridge('denied')
    renderCard()
    await waitFor(() => expect(lookups).toEqual([]))
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
  })
})
