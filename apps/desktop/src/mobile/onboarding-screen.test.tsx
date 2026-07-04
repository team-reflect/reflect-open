import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, type MobileStorageInfo } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { MobileOnboardingScreen } from './onboarding-screen'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

const completeOnboarding = vi.hoisted(() => vi.fn(async (_kind: string) => {}))
const storageInfo = vi.hoisted<{ current: unknown }>(() => ({ current: null }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ mobileStorageInfo: storageInfo.current, completeOnboarding }),
}))

function setStorage(info: MobileStorageInfo): void {
  storageInfo.current = info
}

let cloned: Array<Record<string, unknown>>
/** When set, `git_clone` never resolves — to exercise the in-flight UI. */
let hangClone: boolean

beforeEach(() => {
  cloned = []
  hangClone = false
  setStorage({ localRoot: '/Documents', icloudRoot: '/iCloud/Documents', icloudHasGraph: false })
  setBridge({
    invoke: async (command, args) => {
      if (command === 'secret_get') {
        // A stored credential lets the auth step advance straight to the repo step.
        return JSON.stringify({ kind: 'pat', token: 'ghp_abc' })
      }
      if (command === 'git_clone') {
        cloned.push(args)
        if (hangClone) {
          return new Promise(() => {}) // stays pending
        }
        return null
      }
      return null
    },
    listen: async () => () => {},
  })
  // GET /user accepts the stored token and identifies the account.
  httpFetch.mockResolvedValue(
    new Response(JSON.stringify({ login: 'alex' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
})

afterEach(() => {
  cleanup()
  setBridge(null)
  vi.clearAllMocks()
})

describe('MobileOnboardingScreen', () => {
  it('leads with iCloud Drive and opens the container graph', async () => {
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Store in iCloud Drive' }))

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith('icloud'))
    expect(cloned).toEqual([])
  })

  it('offers to open existing iCloud notes when the container already has them', async () => {
    setStorage({ localRoot: '/Documents', icloudRoot: '/iCloud/Documents', icloudHasGraph: true })
    render(<MobileOnboardingScreen />)

    expect(screen.getByText('We found notes in your iCloud Drive.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open your iCloud notes' }))

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith('icloud'))
  })

  it('keeps notes on this device without cloning', async () => {
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep notes on this device' }))

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith('local'))
    expect(cloned).toEqual([])
  })

  it('hides the iCloud action and explains why when iCloud is unavailable', () => {
    setStorage({ localRoot: '/Documents', icloudRoot: null, icloudHasGraph: false })
    render(<MobileOnboardingScreen />)

    expect(screen.queryByRole('button', { name: 'Store in iCloud Drive' })).toBeNull()
    expect(
      screen.getByText('Sign in to iCloud on this device to sync notes with iCloud Drive.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep notes on this device' })).toBeTruthy()
  })

  it('clones the chosen repo into the local root, then completes onboarding', async () => {
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Sync with GitHub instead' }))
    // The stored credential auto-advances past auth to the repo step.
    await waitFor(() => expect(screen.getByLabelText('Backup repository')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Backup repository'), {
      target: { value: 'notes' }, // bare name → the signed-in account
    })
    fireEvent.click(screen.getByRole('button', { name: 'Download & open' }))

    await waitFor(() =>
      expect(cloned).toEqual([
        { url: 'https://github.com/alex/notes.git', path: '/Documents', token: 'ghp_abc' },
      ]),
    )
    expect(completeOnboarding).toHaveBeenCalledWith('local')
  })

  it('disables Back while a clone is in flight (can’t leave it running)', async () => {
    hangClone = true
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Sync with GitHub instead' }))
    await waitFor(() => expect(screen.getByLabelText('Backup repository')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Backup repository'), { target: { value: 'notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Download & open' }))

    // The clone is pending, so Back must be disabled — leaving would let the
    // clone finish and open the graph after the user returned to the choice.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    )
  })

  it('rejects an empty repo name instead of cloning', async () => {
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Sync with GitHub instead' }))
    await waitFor(() => expect(screen.getByLabelText('Backup repository')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Download & open' }))

    expect(
      await screen.findByText('Enter the repository name (or owner/name for another account).'),
    ).toBeTruthy()
    expect(cloned).toEqual([])
    expect(completeOnboarding).not.toHaveBeenCalled()
  })
})
