import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNote, type GraphInfo } from '@reflect/core'
import { SyncConflictNotice } from './sync-conflict-notice'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote: vi.fn(),
}))

const graphState = vi.hoisted(() => ({
  graph: { root: '/g', name: 'G', cloudSync: null, generation: 3 } as GraphInfo | null,
  indexGeneration: 7 as number | null,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphState }))

const resolution = vi.hoisted(() => ({
  busy: false,
  error: null as string | null,
  resolve: vi.fn(async () => {}),
}))
vi.mock('@/hooks/use-conflict-resolution', () => ({
  useConflictResolution: () => resolution,
}))

const NOTE = {
  path: 'notes/clash.md',
  title: 'Clash',
  dailyDate: null,
  isPrivate: false,
  hasConflict: true,
}

let queryClient: QueryClient

beforeEach(() => {
  resolution.error = null
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

function renderNotice(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SyncConflictNotice path="notes/clash.md" />
    </QueryClientProvider>,
  )
}

describe('SyncConflictNotice', () => {
  it('renders nothing for a note without conflict markers', async () => {
    vi.mocked(getNote).mockResolvedValue({ ...NOTE, hasConflict: false })
    renderNotice()

    await Promise.resolve() // let the query settle
    expect(screen.queryByText(/edited on two devices/i)).toBeNull()
  })

  it('offers mine/theirs/both resolutions for a conflicted note', async () => {
    vi.mocked(getNote).mockResolvedValue(NOTE)
    renderNotice()

    expect(await screen.findByText(/edited on two devices/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /keep this device’s version/i }))
    expect(resolution.resolve).toHaveBeenCalledWith('ours')

    fireEvent.click(screen.getByRole('button', { name: /keep the other device’s/i }))
    expect(resolution.resolve).toHaveBeenCalledWith('theirs')

    fireEvent.click(screen.getByRole('button', { name: /keep both/i }))
    expect(resolution.resolve).toHaveBeenCalledWith('both')
  })
})
