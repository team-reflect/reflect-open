import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  cleanup() // `globals: false` disables testing-library's automatic cleanup
  setBridge(null)
  queryClient.clear()
})

describe('GraphChooser', () => {
  it('explains how to open Reflect V1 folder exports', async () => {
    render(<GraphChooser />, { wrapper })

    await waitFor(() =>
      expect(
        screen.getByText(
          'Moving from Reflect V1? In V1, go to Settings > Graph > Export, export a "Reflect Open folder", then open it here.',
        ),
      ).toBeInTheDocument(),
    )
  })

  // The provider auto-opens the most recent graph on mount, so the chooser's
  // own flows are exercised after that first open settles.
  it('lists recent graphs and reopens one on click', async () => {
    const user = userEvent.setup()
    render(<GraphChooser />, { wrapper })

    await waitFor(() => expect(screen.getByText('personal')).toBeInTheDocument())
    expect(screen.getByText('/graphs/personal')).toBeInTheDocument()

    await user.click(screen.getByText('personal'))
    await waitFor(() =>
      expect(invokeLog).toContainEqual(['graph_open', { path: '/graphs/personal' }]),
    )
  })

  it('forgets a recent graph and refreshes the list', async () => {
    const user = userEvent.setup()
    render(<GraphChooser />, { wrapper })

    await waitFor(() => expect(screen.getByText('personal')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Forget personal' }))

    await waitFor(() => expect(screen.queryByText('personal')).not.toBeInTheDocument())
    expect(invokeLog).toContainEqual(['forget_recent', { root: '/graphs/personal' }])
  })

  it('tints a recent folder icon with the chosen graph color, muted otherwise', async () => {
    storedSettings = { graphColors: { '/graphs/personal': 'teal' } }
    render(<GraphChooser />, { wrapper })

    await waitFor(() => expect(screen.getByText('personal')).toBeInTheDocument())
    const personalIcon = screen
      .getByText('personal')
      .closest('button')
      ?.querySelector('svg')
    await waitFor(() => expect(personalIcon).toHaveStyle({ color: '#14b8a6' }))

    const workIcon = screen.getByText('work').closest('button')?.querySelector('svg')
    expect(workIcon).toHaveClass('text-text-muted')
  })
})
