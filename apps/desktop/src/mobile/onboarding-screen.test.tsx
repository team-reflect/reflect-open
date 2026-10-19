import { page } from 'vitest/browser'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import type { MobileOnboardingService } from '@reflect/app'
import { createTestAppServices } from '@reflect/app/testing'
import type { MobileStorageInfo } from '@reflect/core'
import {
  createTestCoreServices,
  createTestMobileStorageService,
  createTestPlatformService,
} from '@reflect/core/testing'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileOnboardingScreen } from './onboarding-screen.tsx'

const STORAGE: MobileStorageInfo = {
  localRoot: '/Documents',
  icloudDocumentsRoot: '/iCloud/Documents',
  icloudGraphRoots: [],
}

let completeOnboarding: MockInstance<MobileOnboardingService['completeOnboarding']>

/**
 * Render the first-run screen on the mobile platform, with the choice observed by the spy.
 */
async function mount(options?: {
  storage?: MobileStorageInfo
  resolving?: boolean
}): Promise<void> {
  const storage = options?.storage ?? STORAGE
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService(MOBILE_PLATFORM),
    mobileStorage: createTestMobileStorageService({ storage }),
  })
  const appServices = createTestAppServices(app)
  completeOnboarding = vi
    .spyOn(appServices.mobileOnboarding, 'completeOnboarding')
    .mockImplementation(async () => {})
  await renderInApp(<MobileOnboardingScreen />, {
    app,
    appServices,
    graph: null,
    mobile: { needsOnboarding: true, storageInfo: storage, resolving: options?.resolving ?? false },
  })
}

describe('MobileOnboardingScreen', () => {
  it('leads with iCloud sync and creates the named iCloud notes', async () => {
    await mount()

    await expect
      .element(page.getByRole('heading', { name: 'iCloud sync', exact: true }))
      .toBeVisible()
    await expect.element(page.getByLabelText('Graph name')).toHaveValue('Notes')
    fireEvent.change(page.getByLabelText('Graph name'), { target: { value: 'Journal' } })
    await page.getByRole('button', { name: 'Setup graph' }).click()

    await vi.waitFor(() => {
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal')
    })
  })

  it('lists every container graph while keeping create available', async () => {
    await mount({
      storage: {
        localRoot: '/Documents',
        icloudDocumentsRoot: '/iCloud/Documents',
        icloudGraphRoots: ['/iCloud/Documents/Notes', '/iCloud/Documents/Work'],
      },
    })

    await expect
      .element(page.getByText('We found notes in iCloud Drive. Continue with one, or start fresh.'))
      .toBeVisible()
    await expect.element(page.getByText('Start fresh', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Continue with Notes' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Setup graph' })).toBeDisabled()
    await page.getByRole('button', { name: 'Continue with Work' }).click()

    await vi.waitFor(() => {
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Work')
    })
  })

  it('creates a new iCloud graph alongside existing ones', async () => {
    await mount({
      storage: {
        localRoot: '/Documents',
        icloudDocumentsRoot: '/iCloud/Documents',
        icloudGraphRoots: ['/iCloud/Documents/Notes'],
      },
    })

    fireEvent.change(page.getByLabelText('Graph name'), { target: { value: 'Journal' } })
    await page.getByRole('button', { name: 'Setup graph' }).click()

    await vi.waitFor(() => {
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal')
    })
  })

  it('keeps the on-device choice as a quiet secondary path', async () => {
    await mount()

    expect(page.getByText(/Your notes are plain markdown files/i).query()).toBeNull()
    expect(
      page.getByText('No iCloud sync. You can add GitHub later from Settings.').query(),
    ).toBeNull()
    await page.getByRole('button', { name: 'Or, use this device only' }).click()

    await vi.waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith('local'))
  })

  it('shows the iCloud section as pending while the container resolves', async () => {
    // Fresh install: the sandbox root is seeded instantly but the container
    // lookup is still running — the iCloud card must read as loading, not as
    // signed-out, and the create form must wait for the real listing.
    await mount({
      storage: { localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] },
      resolving: true,
    })

    await expect
      .element(page.getByRole('heading', { name: 'iCloud sync', exact: true }))
      .toBeVisible()
    await expect.element(page.getByText('Checking iCloud Drive…')).toBeVisible()
    expect(page.getByRole('button', { name: 'Setup graph' }).query()).toBeNull()
    expect(page.getByText(/Sign in to iCloud/).query()).toBeNull()
    // The on-device path stays live — its root is already known.
    await expect
      .element(page.getByRole('button', { name: 'Or, use this device only' }))
      .toBeEnabled()
  })

  it('keeps the iCloud recommendation visible when iCloud is unavailable', async () => {
    await mount({
      storage: { localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] },
    })

    await expect
      .element(page.getByRole('heading', { name: 'iCloud sync', exact: true }))
      .toBeVisible()
    await expect
      .element(page.getByText('Turn on iCloud Drive to keep your notes synced between devices.'))
      .toBeVisible()
    await expect
      .element(page.getByText('Sign in to iCloud on this device, then reopen Reflect.'))
      .toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Or, use this device only' }))
      .toBeVisible()
  })

  it('does not offer repository setup from the first-run picker', async () => {
    await mount()

    expect(page.getByRole('button', { name: /github/i }).query()).toBeNull()
    expect(page.getByText(/backup repository/i).query()).toBeNull()
    expect(page.getByRole('button', { name: 'Download & open' }).query()).toBeNull()
  })

  it('does not expose folder language in the primary first-run path', async () => {
    await mount()

    expect(page.getByText(/folder/i).query()).toBeNull()
  })
})
