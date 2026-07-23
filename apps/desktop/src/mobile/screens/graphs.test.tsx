import { useEffect, type ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import { MobileGraphs } from './graphs'

/**
 * The Graphs screen (the mobile graph switcher): a checkmark-selection list
 * over the freshly-read storage roots — iCloud container graphs plus the
 * on-device root — switching through the persist-and-open onboarding flow,
 * and graph creation in its own sheet instead of an inline form.
 */

// vaul needs browser APIs jsdom doesn't provide; passthrough so the sheet
// content always renders (the drawer itself is verified on-device).
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    useEffect(() => {
      onOpenChange?.(true)
    }, [onOpenChange])
    return <>{children}</>
  },
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const storageInfo = vi.hoisted(() => ({
  current: {
    localRoot: '/Documents',
    icloudDocumentsRoot: null as string | null,
    icloudGraphRoots: [] as string[],
  },
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  mobileStorage: vi.fn(async () => storageInfo.current),
}))

const completeOnboarding = vi.hoisted(() =>
  vi.fn(async (_kind: string, _root?: string) => {}),
)
const graphState = vi.hoisted(() => ({ root: '/iCloud/Documents/Notes' }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: graphState.root, name: 'Notes', generation: 1 } as GraphInfo,
    completeOnboarding,
  }),
}))

const navigate = vi.hoisted(() => vi.fn())
const back = vi.hoisted(() => vi.fn())
vi.mock('@/routing/router', () => ({
  useRouter: () => ({ navigate, back, canBack: true }),
}))

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  graphState.root = '/iCloud/Documents/Notes'
  storageInfo.current = {
    localRoot: '/Documents',
    icloudDocumentsRoot: '/iCloud/Documents',
    icloudGraphRoots: ['/iCloud/Documents/Notes', '/iCloud/Documents/Work'],
  }
  completeOnboarding.mockImplementation(async () => {})
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

function mount(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <MobileGraphs />
    </QueryClientProvider>,
  )
}

describe('MobileGraphs', () => {
  it('checkmarks the open graph and switches on tapping another', async () => {
    const user = userEvent.setup()
    mount()

    const current = await screen.findByRole('button', { name: 'Notes' })
    expect(current.getAttribute('aria-current')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Work'),
    )
  })

  it('ignores a tap on the graph that is already open', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'Notes' }))
    expect(completeOnboarding).not.toHaveBeenCalled()
  })

  it('switches to the on-device root', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'This device' }))
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith('local', '/Documents'))
  })

  it('creates a graph through the sheet, not an inline form', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'New graph' }))
    await user.type(screen.getByLabelText('Name'), 'Journal')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('rejects a colliding name before it ever reaches the backend', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'New graph' }))
    await user.type(screen.getByLabelText('Name'), 'Work')

    expect(await screen.findByText(/already exists in iCloud Drive/)).toBeTruthy()
    // The collision disables Create, so the name can never reach the backend.
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
    expect(completeOnboarding).not.toHaveBeenCalled()
  })

  it('surfaces a failed switch and stays on the list', async () => {
    completeOnboarding.mockRejectedValueOnce(new Error('clone failed'))
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'Work' }))
    expect(await screen.findByText('clone failed')).toBeTruthy()
  })

  it('says so when iCloud Drive is unavailable', async () => {
    storageInfo.current = {
      localRoot: '/Documents',
      icloudDocumentsRoot: null,
      icloudGraphRoots: [],
    }
    mount()

    expect(await screen.findByText(/iCloud Drive isn’t available/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New graph' })).toBeNull()
  })
})
