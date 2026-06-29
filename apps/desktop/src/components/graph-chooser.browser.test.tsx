import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { setBridge } from '@reflect/core'
import { GraphProvider } from '@/providers/graph-provider'
import { SettingsProvider } from '@/providers/settings-provider'
import { GraphChooser } from './graph-chooser'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

let invokeLog: Array<[string, Record<string, unknown>]>
let recents: Array<{ root: string; name: string; openedMs: number }>
let storedSettings: Record<string, unknown>
let queryClient: QueryClient

// Mirrors the main.tsx provider order: settings above the graph lifecycle.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <SettingsProvider>
      <GraphProvider>{children}</GraphProvider>
    </SettingsProvider>
  </QueryClientProvider>
)

beforeEach(() => {
  invokeLog = []
  recents = [
    { root: '/graphs/work', name: 'work', openedMs: 2 },
    { root: '/graphs/personal', name: 'personal', openedMs: 1 },
  ]
  storedSettings = {}
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  setBridge({
    invoke: async (command, args) => {
      invokeLog.push([command, args])
      switch (command) {
        case 'recent_graphs':
          return recents
        case 'forget_recent':
          recents = recents.filter((recent) => recent.root !== args['root'])
          return null
        case 'graph_open':
          return { root: String(args['path']), name: 'work', cloudSync: null, generation: 1 }
        case 'index_open':
          return 1
        case 'list_files':
        case 'db_query':
          return []
        case 'settings_load':
          return storedSettings
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
})

describe('GraphChooser', () => {
  it('separates the new-user and Reflect V1 migration paths', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect
      .element(page.getByRole('heading', { name: 'New to Reflect' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: /Choose a folder/ }))
      .toBeInTheDocument()

    // The V1 path keeps the export → unzip → open guidance, now as numbered steps.
    await expect
      .element(page.getByRole('heading', { name: 'Coming from Reflect v1' }))
      .toBeInTheDocument()
    await expect.element(page.getByText(/Settings → Graph → Export/)).toBeInTheDocument()
    await expect.element(page.getByText(/Unzip the file and move the folder/)).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: /Open exported folder/ }))
      .toBeInTheDocument()
  })

  // The provider auto-opens the most recent graph on mount, so the chooser's
  // own flows are exercised after that first open settles.
  it('lists recent graphs and reopens one on click', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText('/graphs/personal')).toBeInTheDocument()

    await userEvent.click(page.getByText('personal', { exact: true }))
    await vi.waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/graphs/personal' }]),
    )
  })

  it('forgets a recent graph and refreshes the list', async () => {
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal', { exact: true })).toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: 'Forget personal' }))

    await expect.element(page.getByText('personal', { exact: true })).not.toBeInTheDocument()
    expect(invokeLog).toContainEqual(['forget_recent', { root: '/graphs/personal' }])
  })

  it('tints a recent folder icon with the chosen graph color, muted otherwise', async () => {
    storedSettings = { graphColors: { '/graphs/personal': 'teal' } }
    await render(<GraphChooser />, { wrapper })

    await expect.element(page.getByText('personal', { exact: true })).toBeInTheDocument()
    const personalIcon = page
      .getByText('personal', { exact: true })
      .element()
      .closest('button')
      ?.querySelector('svg')
    await expect.element(page.elementLocator(personalIcon!)).toHaveStyle({ color: '#14b8a6' })

    const workIcon = page
      .getByText('work', { exact: true })
      .element()
      .closest('button')
      ?.querySelector('svg')
    await expect.element(page.elementLocator(workIcon!)).toHaveClass('text-text-muted')
  })
})
