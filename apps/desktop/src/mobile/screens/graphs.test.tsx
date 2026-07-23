import { useEffect, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import { MobileGraphs } from './graphs'

/**
 * The Graphs screen (the mobile graph switcher): a checkmark-selection list
 * over the freshly-read storage roots — iCloud container graphs plus the
 * on-device root — switching through the persist-and-open onboarding flow,
 * and graph creation in its own sheet instead of an inline form.
 */

// Keep the sheet content inline so this suite focuses on graph switching.
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

afterEach(async () => {
  await cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

async function mount(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <MobileGraphs />
    </QueryClientProvider>,
  )
}

describe('MobileGraphs', () => {
  it('checkmarks the open graph and switches on tapping another', async () => {
    await mount()

    await expect
      .element(page.getByRole('button', { name: 'Notes' }))
      .toHaveAttribute('aria-current', 'true')

    await userEvent.click(page.getByRole('button', { name: 'Work' }))
    await vi.waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Work'),
    )
  })

  it('ignores a tap on the graph that is already open', async () => {
    await mount()

    await userEvent.click(page.getByRole('button', { name: 'Notes' }))
    expect(completeOnboarding).not.toHaveBeenCalled()
  })

  it('switches to the on-device root', async () => {
    await mount()

    await userEvent.click(page.getByRole('button', { name: 'This device' }))
    await vi.waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('local', '/Documents'),
    )
  })

  it('creates a graph through the sheet, not an inline form', async () => {
    await mount()

    await userEvent.click(page.getByRole('button', { name: 'New graph' }))
    await userEvent.fill(page.getByLabelText('Name'), 'Journal')
    await userEvent.click(page.getByRole('button', { name: 'Create' }))

    await vi.waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('rejects a colliding name before it ever reaches the backend', async () => {
    await mount()

    await userEvent.click(page.getByRole('button', { name: 'New graph' }))
    await userEvent.fill(page.getByLabelText('Name'), 'Work')

    await expect.element(page.getByText(/already exists in iCloud Drive/)).toBeVisible()
    // The collision disables Create, so the name can never reach the backend.
    await expect.element(page.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(completeOnboarding).not.toHaveBeenCalled()
  })

  it('surfaces a failed switch and stays on the list', async () => {
    completeOnboarding.mockRejectedValueOnce(new Error('clone failed'))
    await mount()

    await userEvent.click(page.getByRole('button', { name: 'Work' }))
    await expect.element(page.getByText('clone failed')).toBeVisible()
  })

  it('says so when iCloud Drive is unavailable', async () => {
    storageInfo.current = {
      localRoot: '/Documents',
      icloudDocumentsRoot: null,
      icloudGraphRoots: [],
    }
    await mount()

    await expect.element(page.getByText(/iCloud Drive isn’t available/)).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'New graph' }))
      .not.toBeInTheDocument()
  })
})
