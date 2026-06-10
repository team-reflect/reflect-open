import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setBridge, type EmbedStatus } from '@reflect/core'
import { SettingsProvider } from '@/providers/settings-provider'
import { SettingsScreen } from './settings-screen'

let stored: Record<string, unknown>
let saved: unknown[]
let invoked: string[]
let embedStatus: EmbedStatus

function installFakeBridge(): void {
  saved = []
  invoked = []
  setBridge({
    invoke: async (command, args) => {
      invoked.push(command)
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          saved.push(args.settings)
          return null
        case 'embed_status':
        case 'embed_ensure':
          return embedStatus
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
  embedStatus = { status: 'uninitialized' }
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
        { editorMarkdownSyntax: 'show', semanticSearchEnabled: false, theme: 'system' },
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
        { editorMarkdownSyntax: 'focus', semanticSearchEnabled: false, theme: 'light' },
      ]),
    )
  })

  it('enabling semantic search persists the opt-in', async () => {
    renderScreen()
    const enable = await screen.findByRole('button', { name: /enable semantic search/i })

    fireEvent.click(enable)

    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'focus', semanticSearchEnabled: true, theme: 'system' },
      ]),
    )
    // The control flips to the loading state (EmbeddingsSync owns the actual
    // download; the runtime here still reports `uninitialized`).
    expect(screen.getByRole('progressbar', { name: /model download/i })).toBeTruthy()
  })

  it('shows byte-level progress while the model downloads', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'loading', downloadedBytes: 45_000_000, totalBytes: 90_000_000 }
    renderScreen()

    const bar = await screen.findByRole('progressbar', { name: /model download/i })
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('50'))
    expect(screen.getByText('Downloading the model — 45 MB of 90 MB')).toBeTruthy()
  })

  it('shows the downloaded model once ready and persists a disable', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'ready', model: 'all-MiniLM-L6-v2' }
    renderScreen()

    expect(await screen.findByText(/model downloaded \(all-MiniLM-L6-v2\)/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /disable/i }))

    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'focus', semanticSearchEnabled: false, theme: 'system' },
      ]),
    )
    expect(screen.getByRole('button', { name: /enable semantic search/i })).toBeTruthy()
  })

  it('re-enabling after a failed load retries the download', async () => {
    embedStatus = { status: 'failed', message: 'offline' }
    renderScreen()
    const enable = await screen.findByRole('button', { name: /enable semantic search/i })

    fireEvent.click(enable)

    // The opt-in persists AND the broken runtime gets a fresh embed_ensure —
    // EmbeddingsSync only loads `uninitialized` runtimes, so the explicit
    // action carries the retry.
    await waitFor(() => expect(invoked).toContain('embed_ensure'))
    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'focus', semanticSearchEnabled: true, theme: 'system' },
      ]),
    )
  })

  it('surfaces a failed load with retry and disable affordances', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'failed', message: 'no disk space' }
    renderScreen()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/no disk space/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()

    // Backing out after a failure must work too — the opt-in isn't a trap.
    fireEvent.click(screen.getByRole('button', { name: /disable/i }))

    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'focus', semanticSearchEnabled: false, theme: 'system' },
      ]),
    )
    expect(screen.getByRole('button', { name: /enable semantic search/i })).toBeTruthy()
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
