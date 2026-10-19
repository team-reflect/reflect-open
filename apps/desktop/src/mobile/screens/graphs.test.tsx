import { useEffect, type ReactNode } from 'react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { MobileOnboardingService } from '@reflect/app'
import { createTestAppServices } from '@reflect/app/testing'
import type { MobileStorageInfo } from '@reflect/core'
import {
  createTestCoreServices,
  createTestMobileStorageService,
  createTestPlatformService,
} from '@reflect/core/testing'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileGraphs } from './graphs.tsx'

/**
 * The Graphs screen (the mobile graph switcher): a checkmark-selection list
 * over the freshly-read storage roots — iCloud container graphs plus the
 * on-device root — switching through the persist-and-open onboarding flow,
 * and graph creation in its own sheet instead of an inline form.
 */

// Keep the sheet content inline so this suite focuses on graph switching.
vi.mock('@/components/ui/drawer.tsx', () => ({
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
  DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const STORAGE: MobileStorageInfo = {
  localRoot: '/Documents',
  icloudDocumentsRoot: '/iCloud/Documents',
  icloudGraphRoots: ['/iCloud/Documents/Notes', '/iCloud/Documents/Work'],
}

type CompleteOnboarding = MobileOnboardingService['completeOnboarding']

let completeOnboarding: MockInstance<CompleteOnboarding>

/**
 * Render the screen on the mobile platform, with the switch flow observed and answered by the spy.
 */
async function mount(storage: MobileStorageInfo = STORAGE): Promise<void> {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService(MOBILE_PLATFORM),
    mobileStorage: createTestMobileStorageService({ storage }),
  })
  const appServices = createTestAppServices(app)
  completeOnboarding = vi
    .spyOn(appServices.mobileOnboarding, 'completeOnboarding')
    .mockImplementation(completeOnboardingResult)
  await renderInApp(<MobileGraphs />, {
    app,
    appServices,
    graph: { root: '/iCloud/Documents/Notes', name: 'Notes' },
    route: { kind: 'graphs' },
  })
}

let completeOnboardingResult: CompleteOnboarding

beforeEach(() => {
  completeOnboardingResult = async () => {}
})

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
    await vi.waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith('local', '/Documents'))
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
    completeOnboardingResult = () => Promise.reject(new Error('clone failed'))
    await mount()

    await userEvent.click(page.getByRole('button', { name: 'Work' }))
    await expect.element(page.getByText('clone failed')).toBeVisible()
  })

  it('says so when iCloud Drive is unavailable', async () => {
    await mount({ localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] })

    await expect.element(page.getByText(/iCloud Drive isn’t available/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'New graph' })).not.toBeInTheDocument()
  })
})
