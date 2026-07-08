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
  it('leads with iCloud sync and creates the named iCloud notes', async () => {
    render(<MobileOnboardingScreen />)

    expect(screen.getByRole('heading', { name: 'iCloud sync' })).toBeTruthy()
    expect(screen.getByLabelText('Graph name')).toHaveProperty('value', 'Notes')
    fireEvent.change(screen.getByLabelText('Graph name'), { target: { value: 'Journal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Setup graph' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
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
      (screen.getByRole('button', { name: 'Setup graph' }) as HTMLButtonElement).disabled,
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

    fireEvent.change(screen.getByLabelText('Graph name'), { target: { value: 'Journal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Setup graph' }))

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith('icloud', '/iCloud/Documents/Journal'),
    )
  })

  it('keeps the on-device choice as a quiet secondary path', async () => {
    render(<MobileOnboardingScreen />)

    expect(screen.queryByText(/Your notes are plain markdown files/i)).toBeNull()
    expect(screen.queryByText('No iCloud sync. You can add GitHub later from Settings.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Or, use this device only' }))

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
    expect(screen.queryByRole('button', { name: 'Setup graph' })).toBeNull()
    expect(screen.queryByText(/Sign in to iCloud/)).toBeNull()
    // The on-device path stays live — its root is already known.
    const local = screen.getByRole('button', { name: 'Or, use this device only' })
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
    expect(screen.getByRole('button', { name: 'Or, use this device only' })).toBeTruthy()
  })

  it('does not offer repository setup from the first-run picker', () => {
    render(<MobileOnboardingScreen />)

    expect(screen.queryByRole('button', { name: /github/i })).toBeNull()
    expect(screen.queryByText(/backup repository/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download & open' })).toBeNull()
  })

  it('does not expose folder language in the primary first-run path', () => {
    render(<MobileOnboardingScreen />)

    expect(screen.queryByText(/folder/i)).toBeNull()
  })
})
