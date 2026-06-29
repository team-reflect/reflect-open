import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
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
/** When set, `git_clone` never resolves, to exercise the in-flight UI. */
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
  setBridge(null)
  vi.clearAllMocks()
})

describe('MobileOnboardingScreen', () => {
  it('starts a fresh graph without cloning', async () => {
    await render(<MobileOnboardingScreen />)

    await userEvent.click(page.getByRole('button', { name: 'Start fresh' }))

    await vi.waitFor(() => expect(completeOnboarding).toHaveBeenCalled())
    expect(cloned).toEqual([])
  })

  it('clones the chosen repo into the fixed root, then completes onboarding', async () => {
    await render(<MobileOnboardingScreen />)

    await userEvent.click(page.getByRole('button', { name: 'Connect to GitHub' }))
    // The stored credential auto-advances past auth to the repo step.
    await expect.element(page.getByLabelText('Backup repository')).toBeInTheDocument()

    // bare name → the signed-in account
    await userEvent.fill(page.getByLabelText('Backup repository'), 'notes')
    await userEvent.click(page.getByRole('button', { name: 'Download & open' }))

    await vi.waitFor(() =>
      expect(cloned).toEqual([
        { url: 'https://github.com/alex/notes.git', path: '/Documents', token: 'ghp_abc' },
      ]),
    )
    expect(completeOnboarding).toHaveBeenCalled()
  })

  it('disables Back while a clone is in flight (can’t leave it running)', async () => {
    hangClone = true
    await render(<MobileOnboardingScreen />)

    await userEvent.click(page.getByRole('button', { name: 'Connect to GitHub' }))
    await expect.element(page.getByLabelText('Backup repository')).toBeInTheDocument()

    await userEvent.fill(page.getByLabelText('Backup repository'), 'notes')
    await userEvent.click(page.getByRole('button', { name: 'Download & open' }))

    // The clone is pending, so Back must be disabled, leaving would let the
    // clone finish and open the graph after the user returned to the choice.
    await expect.element(page.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('rejects an empty repo name instead of cloning', async () => {
    await render(<MobileOnboardingScreen />)

    await userEvent.click(page.getByRole('button', { name: 'Connect to GitHub' }))
    await expect.element(page.getByLabelText('Backup repository')).toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Download & open' }))

    await expect
      .element(page.getByText('Enter the repository name (or owner/name for another account).'))
      .toBeInTheDocument()
    expect(cloned).toEqual([])
    expect(completeOnboarding).not.toHaveBeenCalled()
  })
})
