import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setBridge } from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider'
import { SettingsScreen } from './settings-screen'

let stored: Record<string, unknown>
let saved: unknown[]

function installFakeBridge(): void {
  saved = []
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          saved.push(args.settings)
          return null
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

function renderScreen(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <SettingsScreen />
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

function radio(name: RegExp): HTMLInputElement {
  const element = screen.getByRole('radio', { name })
  if (!(element instanceof HTMLInputElement)) {
    throw new Error('expected an <input type="radio">')
  }
  return element
}

beforeEach(() => {
  stored = {}
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
})

afterEach(() => {
  cleanup() // `globals: false` disables testing-library's automatic cleanup
  setBridge(null)
  queryClient.clear()
})

describe('SettingsScreen', () => {
  it('reflects the persisted markdown syntax mode', async () => {
    stored = { editorMarkdownSyntax: 'show' }
    renderScreen()
    await waitFor(() => expect(radio(/^show/i).checked).toBe(true))
    expect(radio(/^focus/i).checked).toBe(false)
  })

  it('selecting Show applies instantly and persists', async () => {
    renderScreen()
    await waitFor(() => expect(radio(/^focus/i).checked).toBe(true))

    fireEvent.click(radio(/^show/i))

    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'show',
          theme: 'system',
          allNotesFilterTags: ['book', 'link', 'person'],
        },
      ]),
    )
    expect(radio(/^show/i).checked).toBe(true)
    expect(radio(/^focus/i).checked).toBe(false)
  })

  it('reflects the persisted theme and persists a new choice', async () => {
    stored = { theme: 'dark' }
    renderScreen()
    await waitFor(() => expect(radio(/^dark/i).checked).toBe(true))

    fireEvent.click(radio(/^light/i))

    expect(radio(/^light/i).checked).toBe(true)
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'focus',
          theme: 'light',
          allNotesFilterTags: ['book', 'link', 'person'],
        },
      ]),
    )
  })

  it('adds an All Notes filter tag, normalized, and persists it', async () => {
    renderScreen()
    const input = screen.getByLabelText('Add filter tag')

    fireEvent.change(input, { target: { value: ' #Meeting ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText('#meeting')).toBeTruthy()
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'focus',
          theme: 'system',
          allNotesFilterTags: ['book', 'link', 'person', 'meeting'],
        },
      ]),
    )
  })

  it('rejects a tag name outside the #tag grammar with an inline error', async () => {
    renderScreen()
    const input = screen.getByLabelText('Add filter tag')
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('expected an <input>')
    }

    fireEvent.change(input, { target: { value: 'my tag' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByRole('alert').textContent).toContain(`"my tag" can't be a tag`)
    // The draft stays put for fixing, and nothing reaches the store.
    expect(input.value).toBe('my tag')
    await waitFor(() => expect(saved).toEqual([]))
  })

  it('ignores adding a duplicate filter tag', async () => {
    stored = { allNotesFilterTags: ['book'] }
    renderScreen()
    // Defaults render before the disk document lands — wait for hydration
    // (the stored list has no `person`) so the click edits the loaded list.
    await waitFor(() => expect(screen.queryByText('#person')).toBeNull())
    expect(screen.getByText('#book')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Add filter tag'), { target: { value: 'BOOK' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(saved).toEqual([]))
  })

  it('removes a filter tag and persists the rest', async () => {
    stored = { allNotesFilterTags: ['book', 'person'] }
    renderScreen()
    // Wait for hydration (the stored list has no `link`), not just defaults.
    await waitFor(() => expect(screen.queryByText('#link')).toBeNull())
    expect(screen.getByText('#book')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove book' }))

    expect(screen.queryByText('#book')).toBeNull()
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'focus',
          theme: 'system',
          allNotesFilterTags: ['person'],
        },
      ]),
    )
  })

  it('lists registered shortcuts from both keymap scopes', () => {
    renderScreen()
    // App scope (command titles) and editor scope (binding descriptions).
    expect(screen.getByText('Toggle sidebar')).toBeTruthy()
    expect(screen.getByText('Go to today')).toBeTruthy()
    expect(screen.getByText('Bold')).toBeTruthy()
    expect(screen.getByText('Heading 1')).toBeTruthy()
  })
})
