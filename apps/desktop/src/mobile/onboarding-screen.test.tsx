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
  it('leads with iCloud Drive and creates the named container graph', async () => {
    render(<MobileOnboardingScreen />)

    expect(screen.getByRole('heading', { name: 'iCloud Drive' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

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

    expect(screen.getByText('Open an existing graph from iCloud Drive.')).toBeTruthy()
    expect(screen.getByText('or create new graph')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Notes' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('keeps notes on this device without cloning', async () => {
    render(<MobileOnboardingScreen />)

    expect(screen.getByRole('heading', { name: 'This device' })).toBeTruthy()
    expect(screen.getByText('Stored locally in Reflect on this device.')).toBeTruthy()
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

    expect(screen.getByRole('heading', { name: 'iCloud Drive' })).toBeTruthy()
    expect(screen.getByText('Looking for your notes…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
    expect(screen.queryByText(/Sign in to iCloud/)).toBeNull()
    // The on-device path stays live — its root is already known.
    const local = screen.getByRole('button', { name: 'Keep notes on this device' })
    expect((local as HTMLButtonElement).disabled).toBe(false)
  })

  it('hides the iCloud action and explains why when iCloud is unavailable', () => {
    setStorage({ localRoot: '/Documents', icloudDocumentsRoot: null, icloudGraphRoots: [] })
    render(<MobileOnboardingScreen />)

    expect(screen.queryByRole('heading', { name: 'iCloud Drive' })).toBeNull()
    expect(
      screen.getByText('Sign in to iCloud on this device to sync notes with iCloud Drive.'),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'This device' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep notes on this device' })).toBeTruthy()
  })

  it('does not offer repository setup from the first-run picker', () => {
    render(<MobileOnboardingScreen />)

    expect(screen.queryByRole('button', { name: /github/i })).toBeNull()
    expect(screen.queryByText(/backup repository/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download & open' })).toBeNull()
  })
})
