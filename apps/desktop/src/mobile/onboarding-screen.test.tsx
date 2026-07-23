import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileStorageInfo } from '@reflect/core'
import { fireEvent } from '@/test-utils/fire-event'
import { MobileOnboardingScreen } from './onboarding-screen'

const completeOnboarding = vi.hoisted(() => vi.fn(async (_kind: string, _root?: string) => {}))
const storageInfo = vi.hoisted<{ current: unknown }>(() => ({ current: null }))
const storageResolving = vi.hoisted<{ current: boolean }>(() => ({ current: false }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    mobileStorageInfo: storageInfo.current,
    mobileStorageResolving: storageResolving.current,
    completeOnboarding,
  }),
}))

function setStorage(info: MobileStorageInfo): void {
  storageInfo.current = info
}

beforeEach(() => {
  storageResolving.current = false
  setStorage({
    localRoot: '/Documents',
    icloudDocumentsRoot: '/iCloud/Documents',
    icloudGraphRoots: [],
  })
})

afterEach(async () => {
  await cleanup()
  vi.clearAllMocks()
})

describe('MobileOnboardingScreen', () => {
  it('leads with iCloud sync and creates the named iCloud notes', async () => {
    await render(<MobileOnboardingScreen />)

    await expect
      .element(page.getByRole('heading', { name: 'iCloud sync', exact: true }))
      .toBeVisible()
    await expect.element(page.getByLabelText('Graph name')).toHaveValue('Notes')
    fireEvent.change(page.getByLabelText('Graph name'), { target: { value: 'Journal' } })
    await page.getByRole('button', { name: 'Setup graph' }).click()

    await vi.waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('lists every container graph while keeping create available', async () => {
    setStorage({
      localRoot: '/Documents',
      icloudDocumentsRoot: '/iCloud/Documents',
      icloudGraphRoots: ['/iCloud/Documents/Notes', '/iCloud/Documents/Work'],
    })
    await render(<MobileOnboardingScreen />)

    await expect
      .element(page.getByText('We found notes in iCloud Drive. Continue with one, or start fresh.'))
      .toBeVisible()
    await expect.element(page.getByText('Start fresh', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Continue with Notes' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Setup graph' })).toBeDisabled()
    await page.getByRole('button', { name: 'Continue with Work' }).click()

    await vi.waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Work'),
    )
  })

  it('creates a new iCloud graph alongside existing ones', async () => {
    setStorage({
      localRoot: '/Documents',
      icloudDocumentsRoot: '/iCloud/Documents',
      icloudGraphRoots: ['/iCloud/Documents/Notes'],
    })
    await render(<MobileOnboardingScreen />)

    fireEvent.change(page.getByLabelText('Graph name'), { target: { value: 'Journal' } })
    await page.getByRole('button', { name: 'Setup graph' }).click()

    await vi.waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('keeps the on-device choice as a quiet secondary path', async () => {
    await render(<MobileOnboardingScreen />)

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
    storageResolving.current = true
    setStorage({ localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] })
    await render(<MobileOnboardingScreen />)

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
    setStorage({ localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] })
    await render(<MobileOnboardingScreen />)

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
    await render(<MobileOnboardingScreen />)

    expect(page.getByRole('button', { name: /github/i }).query()).toBeNull()
    expect(page.getByText(/backup repository/i).query()).toBeNull()
    expect(page.getByRole('button', { name: 'Download & open' }).query()).toBeNull()
  })

  it('does not expose folder language in the primary first-run path', async () => {
    await render(<MobileOnboardingScreen />)

    expect(page.getByText(/folder/i).query()).toBeNull()
  })
})
