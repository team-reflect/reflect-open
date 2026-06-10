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
      expect(saved).toEqual([{ editorMarkdownSyntax: 'show', theme: 'system' }]),
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
      expect(saved).toEqual([{ editorMarkdownSyntax: 'focus', theme: 'light' }]),
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
