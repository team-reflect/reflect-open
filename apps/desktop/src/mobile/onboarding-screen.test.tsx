import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileStorageInfo } from '@reflect/core'
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MobileOnboardingScreen', () => {
  it('leads with iCloud sync and creates the default iCloud notes', async () => {
    render(<MobileOnboardingScreen />)

    expect(screen.getByRole('heading', { name: 'iCloud sync' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue with iCloud' })).toBeTruthy()
    expect(screen.queryByLabelText('Name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue with iCloud' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Notes'),
    )
  })

  it('lists every container graph while keeping create available', async () => {
    setStorage({
      localRoot: '/Documents',
      icloudDocumentsRoot: '/iCloud/Documents',
      icloudGraphRoots: ['/iCloud/Documents/Notes', '/iCloud/Documents/Work'],
    })
    render(<MobileOnboardingScreen />)

    expect(screen.getByText('We found notes in iCloud Drive. Continue with one, or start fresh.')).toBeTruthy()
    expect(screen.getByText('Start fresh')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue with Notes' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Create in iCloud' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Work' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Work'),
    )
  })

  it('creates a new iCloud graph alongside existing ones', async () => {
    setStorage({
      localRoot: '/Documents',
      icloudDocumentsRoot: '/iCloud/Documents',
      icloudGraphRoots: ['/iCloud/Documents/Notes'],
    })
    render(<MobileOnboardingScreen />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Journal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create in iCloud' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('chooses a folder on this device without cloning', async () => {
    render(<MobileOnboardingScreen />)

    expect(screen.queryByText(/Your notes are plain markdown files/i)).toBeNull()
    expect(screen.getByRole('heading', { name: 'This device only' })).toBeTruthy()
    expect(
      screen.getByText(
        'Notes stay on this device and won’t sync through iCloud. You can add GitHub sync later from Settings.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep notes on this device' }))

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith('local'))
  })

  it('shows the iCloud section as pending while the container resolves', () => {
    // Fresh install: the sandbox root is seeded instantly but the container
    // lookup is still running — the iCloud card must read as loading, not as
    // signed-out, and the create form must wait for the real listing.
    storageResolving.current = true
    setStorage({ localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] })
    render(<MobileOnboardingScreen />)

    expect(screen.getByRole('heading', { name: 'iCloud sync' })).toBeTruthy()
    expect(screen.getByText('Checking iCloud Drive…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue with iCloud' })).toBeNull()
    expect(screen.queryByText(/Sign in to iCloud/)).toBeNull()
    // The on-device path stays live — its root is already known.
    const local = screen.getByRole('button', { name: 'Keep notes on this device' })
    expect((local as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the iCloud recommendation visible when iCloud is unavailable', () => {
    setStorage({ localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] })
    render(<MobileOnboardingScreen />)

    expect(screen.getByRole('heading', { name: 'iCloud sync' })).toBeTruthy()
    expect(
      screen.getByText('Turn on iCloud Drive to keep your notes synced between devices.'),
    ).toBeTruthy()
    expect(
      screen.getByText('Sign in to iCloud on this device, then reopen Reflect.'),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'This device only' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep notes on this device' })).toBeTruthy()
  })

  it('does not offer repository setup from the first-run picker', () => {
    render(<MobileOnboardingScreen />)

    expect(screen.queryByRole('button', { name: /github/i })).toBeNull()
    expect(screen.queryByText(/backup repository/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download & open' })).toBeNull()
  })

  it('does not expose graph or folder language in the primary first-run path', () => {
    render(<MobileOnboardingScreen />)

    expect(screen.queryByText(/graph/i)).toBeNull()
    expect(screen.queryByText(/folder/i)).toBeNull()
  })
})
