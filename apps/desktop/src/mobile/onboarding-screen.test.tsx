import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { MobileOnboardingScreen } from './onboarding-screen'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

const completeOnboarding = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ mobileRoot: '/Documents', completeOnboarding }),
}))

let cloned: Array<Record<string, unknown>>
/** When set, `git_clone` never resolves — to exercise the in-flight UI. */
let hangClone: boolean

beforeEach(() => {
  cloned = []
  hangClone = false
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
  it('starts a fresh graph without cloning', async () => {
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }))

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalled())
    expect(cloned).toEqual([])
  })

  it('clones the chosen repo into the fixed root, then completes onboarding', async () => {
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect to GitHub' }))
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
    expect(completeOnboarding).toHaveBeenCalled()
  })

  it('disables Back while a clone is in flight (can’t leave it running)', async () => {
    hangClone = true
    render(<MobileOnboardingScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect to GitHub' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Connect to GitHub' }))
    await waitFor(() => expect(screen.getByLabelText('Backup repository')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Download & open' }))

    expect(
      await screen.findByText('Enter the repository name (or owner/name for another account).'),
    ).toBeTruthy()
    expect(cloned).toEqual([])
    expect(completeOnboarding).not.toHaveBeenCalled()
  })
})
