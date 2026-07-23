import { render } from 'vitest-browser-react'
import { page, userEvent, type Locator } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactMatch, MeetingAttendee, WikiSuggestion } from '@reflect/core'
import { AttendeeCombobox } from './attendee-combobox'

const suggestWikiTargets = vi.hoisted(() => vi.fn<() => Promise<WikiSuggestion[]>>(async () => []))
const contactLinkSuggestions = vi.hoisted(() =>
  vi.fn<() => Promise<ContactMatch[]>>(async () => []),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets,
  contactLinkSuggestions,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { contactsEnabled: true }, updateSettings: () => {} }),
}))
vi.mock('@/hooks/use-contacts-authorization', () => ({
  useContactsAuthorization: () => 'authorized',
}))

function noteSuggestion(title: string, overrides: Partial<WikiSuggestion> = {}): WikiSuggestion {
  return { target: title, path: `notes/${title}.md`, title, alias: null, date: null, ...overrides }
}

function contact(fullName: string, email: string): ContactMatch {
  return { fullName, givenName: '', familyName: '', emails: [email], phones: [] }
}

const onAdd = vi.fn<(attendee: MeetingAttendee) => void>()

async function renderCombobox(attendees: MeetingAttendee[] = []): Promise<Locator> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await render(
    <QueryClientProvider client={client}>
      <AttendeeCombobox attendees={attendees} onAdd={onAdd} />
    </QueryClientProvider>,
  )
  return page.getByPlaceholder('Add attendee')
}

/** cmdk highlights the first row in an effect — selection isn't synchronous. */
async function findHighlighted(text: string): Promise<Locator> {
  const row = page.getByText(text)
  await expect.element(row).toBeInTheDocument()
  await vi.waitFor(() => {
    expect(row.element().closest('[cmdk-item]')?.getAttribute('aria-selected')).toBe('true')
  })
  return row
}

beforeEach(() => {
  suggestWikiTargets.mockReset().mockResolvedValue([])
  contactLinkSuggestions.mockReset().mockResolvedValue([])
  onAdd.mockClear()
})

describe('AttendeeCombobox', () => {
  it('Enter adds the highlighted note suggestion by its canonical title', async () => {
    suggestWikiTargets.mockResolvedValue([noteSuggestion('Ada Lovelace')])
    const input = await renderCombobox()

    await input.fill('ada')
    await findHighlighted('Ada Lovelace')
    await userEvent.keyboard('{Enter}')

    expect(onAdd).toHaveBeenCalledWith({ name: 'Ada Lovelace' })
    await expect.element(input).toHaveValue('')
  })

  it('a picked contact carries all emails for identity resolution', async () => {
    contactLinkSuggestions.mockResolvedValue([
      {
        ...contact('Grace Hopper', 'grace@example.com'),
        emails: ['grace@example.com', 'grace@work.example'],
      },
    ])
    const input = await renderCombobox()

    await input.fill('gra')
    await findHighlighted('Grace Hopper')
    await expect.element(page.getByText('grace@example.com')).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')

    expect(onAdd).toHaveBeenCalledWith({
      name: 'Grace Hopper',
      emails: ['grace@example.com', 'grace@work.example'],
    })
  })

  it('Enter with no suggestions adds the typed name verbatim', async () => {
    const input = await renderCombobox()

    await input.fill('Brand New Person')
    await userEvent.keyboard('{Enter}')

    expect(onAdd).toHaveBeenCalledWith({ name: 'Brand New Person' })
    await expect.element(input).toHaveValue('')
  })

  it('blur does not bypass an exact Contact row', async () => {
    contactLinkSuggestions.mockResolvedValue([
      contact('Grace Hopper', 'grace@example.com'),
    ])
    const input = await renderCombobox()

    await input.fill('Grace Hopper')
    await expect.element(page.getByText('grace@example.com')).toBeInTheDocument()
    await userEvent.tab()

    expect(onAdd).not.toHaveBeenCalled()
    await expect.element(input).toHaveValue('Grace Hopper')
  })

  it('Enter during a pending refetch does not add stale or identity-less text', async () => {
    suggestWikiTargets.mockResolvedValue([noteSuggestion('Ada Lovelace')])
    const input = await renderCombobox()

    await input.fill('ada')
    await findHighlighted('Ada Lovelace')

    // Keep typing: the popover still shows the previous query's rows
    // (keepPreviousData) while the new fetch hangs. Enter must take the
    // live text, not the stale highlighted suggestion.
    suggestWikiTargets.mockReturnValue(new Promise(() => {}))
    await input.fill('Adam Smith')
    await userEvent.keyboard('{Enter}')

    expect(onAdd).not.toHaveBeenCalled()
    await expect.element(input).toHaveValue('Adam Smith')
  })

  it('offers an Add row for a name that matches nothing exactly', async () => {
    suggestWikiTargets.mockResolvedValue([noteSuggestion('Ada Lovelace')])
    const input = await renderCombobox()

    await input.fill('Ada L')
    await userEvent.click(page.getByText('Add “Ada L”'))

    expect(onAdd).toHaveBeenCalledWith({ name: 'Ada L' })
  })

  it('keeps already-added attendees out of the suggestions', async () => {
    suggestWikiTargets.mockResolvedValue([noteSuggestion('Ada Lovelace')])
    const input = await renderCombobox([{ name: 'Ada Lovelace' }])

    await input.fill('Ada Lovelace')
    await vi.waitFor(() => expect(suggestWikiTargets).toHaveBeenCalled())

    expect(page.getByText('Ada Lovelace').query()).toBeNull()
  })

  it('Escape dismisses the suggestions without bubbling to the dialog', async () => {
    suggestWikiTargets.mockResolvedValue([noteSuggestion('Ada Lovelace')])
    const input = await renderCombobox()

    await input.fill('ada')
    await findHighlighted('Ada Lovelace')
    await userEvent.keyboard('{Escape}')

    await expect.element(page.getByText('Ada Lovelace')).not.toBeInTheDocument()
    await expect.element(input).toHaveValue('ada')
  })
})
