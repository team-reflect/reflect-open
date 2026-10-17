import type { ReactNode } from 'react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { GithubAuthService } from '@reflect/core'
import {
  createTestClipboardService,
  createTestOpenerService,
  type TestClipboardService,
  type TestOpenerService,
} from '@reflect/app/testing'
import {
  createTestCoreServices,
  createTestHttpService,
  createTestPlatformService,
  createTestSecretStoreService,
  type TestHttpService,
  type TestSecretStoreService,
} from '@reflect/core/testing'
import { fireEvent } from '@/test-utils/fire-event.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { GithubAuthStep } from './github-auth-step.tsx'

// The device flow leads and the PAT path sits behind a "use a personal access
// token instead" toggle. The
// keychain is the in-memory secret store; GET /user (instant token validation) goes
// through the fake HTTP service. The device-flow tests script the app's
// GithubAuthService's runDeviceFlow (polling policy is unit-tested in core)
// to drive the code-handoff view.

const USER_URL = 'https://api.github.com/user'
let http: TestHttpService
let clipboard: TestClipboardService
let opener: TestOpenerService
let openedUrls: MockInstance<(url: string) => Promise<void>>
let keychain: TestSecretStoreService
const mockFlow = vi.fn<GithubAuthService['runDeviceFlow']>()

beforeEach(() => {
  http = createTestHttpService()
  clipboard = createTestClipboardService()
  opener = createTestOpenerService()
  openedUrls = vi.spyOn(opener, 'openUrl')
  keychain = createTestSecretStoreService()
  mockFlow.mockReset()
})

/**
 * Render the step in an app over the test's keychain, HTTP, clipboard and opener.
 */
async function renderStep(step: ReactNode): Promise<void> {
  const app = createTestCoreServices({
    http,
    secretStore: keychain,
    platform: createTestPlatformService({ isMacosDesktop: false, hasMacosTitleBarOverlay: false }),
  })
  app.githubAuth.onRunDeviceFlow(mockFlow)
  await renderInApp(step, { app, appServices: { clipboard, opener } })
}

/** Switch the step from the device-flow lead to PAT entry. */
async function switchToPat(): Promise<void> {
  await userEvent.click(page.getByRole('button', { name: /use a personal access token instead/i }))
  await expect.element(page.getByLabelText('Personal access token')).toBeVisible()
}

/** Render with no stored credential and a flow that stays at the code view. */
async function renderCodeView(): Promise<void> {
  fakeKeychain()
  mockFlow.mockImplementation(async (options) => {
    options.onCode({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' })
    return await new Promise(() => {}) // polling stays in flight
  })
  await renderStep(<GithubAuthStep onAuthed={vi.fn()} />)
  await userEvent.click(page.getByRole('button', { name: 'Sign in with GitHub' }))
  await expect.element(page.getByText('ABCD-1234')).toBeVisible()
}

/**
 * The in-memory keychain of the app under test, holding `initial`.
 */
function fakeKeychain(initial: Record<string, string> = {}): TestSecretStoreService {
  keychain = createTestSecretStoreService(initial)
  return keychain
}

function githubAccepts(login: string): void {
  http.on('GET', USER_URL, { status: 200, json: { login } })
}

function githubRejects(): void {
  http.on('GET', USER_URL, { status: 401, json: { message: 'Bad credentials' } })
}

describe('GithubAuthStep', () => {
  it('skips itself when a stored credential is still valid, reporting who', async () => {
    fakeKeychain({ 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) })
    githubAccepts('alex')
    const onAuthed = vi.fn()
    await renderStep(<GithubAuthStep onAuthed={onAuthed} />)

    await vi.waitFor(() =>
      expect(onAuthed).toHaveBeenCalledWith({ login: 'alex', avatarUrl: null }),
    )
  })

  it('stores a pasted PAT, verifies it against GitHub, and reports the identity', async () => {
    const store = fakeKeychain()
    githubAccepts('alex')
    const onAuthed = vi.fn()
    await renderStep(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    fireEvent.change(page.getByLabelText('Personal access token'), {
      target: { value: '  github_pat_abc  ' },
    })
    await userEvent.click(page.getByRole('button', { name: 'Save token' }))

    await vi.waitFor(() =>
      expect(onAuthed).toHaveBeenCalledWith({ login: 'alex', avatarUrl: null }),
    )
    expect(JSON.parse(store.snapshot()['github-auth'] ?? '{}')).toEqual({
      kind: 'pat',
      token: 'github_pat_abc',
    })
  })

  it('fails a rejected token at entry and clears it from the keychain', async () => {
    // The whole point of verifying here: a mistyped token must fail in this
    // step, not minutes later at the first sync — and must not stay stored
    // where every later flow would silently skip past sign-in with it.
    const store = fakeKeychain()
    githubRejects()
    const onAuthed = vi.fn()
    await renderStep(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    fireEvent.change(page.getByLabelText('Personal access token'), {
      target: { value: 'github_pat_typo' },
    })
    await userEvent.click(page.getByRole('button', { name: 'Save token' }))

    await expect.element(page.getByText(/rejected the token/i)).toBeVisible()
    expect(onAuthed).not.toHaveBeenCalled()
    expect(store.snapshot()).not.toHaveProperty('github-auth')
  })

  it('rejects an empty token with an inline message', async () => {
    fakeKeychain()
    const onAuthed = vi.fn()
    await renderStep(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    await userEvent.click(page.getByRole('button', { name: 'Save token' }))

    await expect.element(page.getByText('Paste a token first.')).toBeVisible()
    expect(onAuthed).not.toHaveBeenCalled()
  })

  it('names the backup repository in the token instructions when known', async () => {
    fakeKeychain()
    await renderStep(<GithubAuthStep onAuthed={vi.fn()} repoName="my-notes-backup" />)
    await switchToPat()

    await expect.element(page.getByText('my-notes-backup')).toBeVisible()
  })

  it('reports auth exactly once when the mount probe races a fresh sign-in', async () => {
    // A stored credential's mount-time probe is slow; the user saves a new
    // PAT meanwhile. Both paths complete — but the parent connects on every
    // onAuthed, so the late probe must be swallowed, not start a second run.
    fakeKeychain({ 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_old' }) })
    let resolveProbe: (response: Response) => void = () => {}
    let probes = 0
    http.on('GET', USER_URL, () => {
      probes += 1
      return probes === 1
        ? new Promise<Response>((resolve) => (resolveProbe = resolve))
        : Response.json({ login: 'alex' })
    })
    const onAuthed = vi.fn()
    await renderStep(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    fireEvent.change(page.getByLabelText('Personal access token'), {
      target: { value: 'github_pat_new' },
    })
    await userEvent.click(page.getByRole('button', { name: 'Save token' }))
    await vi.waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1))

    // The old credential turns out valid too — its late arrival must not
    // re-fire the step's completion.
    resolveProbe(
      new Response(JSON.stringify({ login: 'alex' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0)) // flush the probe's chain
    expect(onAuthed).toHaveBeenCalledTimes(1)
  })

  it('copies the code to the clipboard before opening GitHub', async () => {
    const writeText = vi.spyOn(clipboard, 'writeText')
    await renderCodeView()

    // GitHub's page asks for the code immediately, so the browser must not
    // open (and steal focus from the visible code) until it's in hand.
    expect(openedUrls).not.toHaveBeenCalled()

    await userEvent.click(page.getByRole('button', { name: 'Copy code and open GitHub' }))

    await vi.waitFor(() =>
      expect(openedUrls).toHaveBeenCalledWith('https://github.com/login/device'),
    )
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
    expect(writeText.mock.invocationCallOrder[0]!).toBeLessThan(
      openedUrls.mock.invocationCallOrder[0]!,
    )
    await expect.element(page.getByText(/code copied/i)).toBeVisible()
  })

  it('surfaces the device URL when the browser cannot be opened', async () => {
    // The handoff URL appears only on failure — it is the one way left to
    // reach the page asking for the code.
    openedUrls.mockRejectedValueOnce(new Error('no handler for https'))
    await renderCodeView()
    await expect.element(page.getByText(/login\/device/)).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Copy code and open GitHub' }))

    await expect
      .element(page.getByText(/visit https:\/\/github\.com\/login\/device yourself/i))
      .toBeVisible()
  })

  it('holds the GitHub handoff when the clipboard is unavailable', async () => {
    clipboard.failWith(new Error('denied'))
    await renderCodeView()

    await userEvent.click(page.getByRole('button', { name: 'Copy code and open GitHub' }))

    // The user is told to copy by hand first; only then does GitHub open.
    await expect.element(page.getByText(/select the code above/i)).toBeVisible()
    expect(openedUrls).not.toHaveBeenCalled()

    await userEvent.click(page.getByRole('button', { name: 'Open GitHub' }))
    await vi.waitFor(() =>
      expect(openedUrls).toHaveBeenCalledWith('https://github.com/login/device'),
    )
  })
})
