import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDeviceFlow, setBridge } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import { GithubAuthStep } from './github-auth-step'

// The Reflect GitHub App is registered, so the device flow leads and the PAT
// path sits behind a "use a personal access token instead" toggle. The
// keychain is the bridge fake; GET /user (instant token validation) goes
// through the mocked Tauri HTTP plugin. The device-flow tests stub core's
// runDeviceFlow (polling policy is unit-tested in core) to drive the
// code-handoff view.

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  runDeviceFlow: vi.fn(),
}))
const httpFetch = vi.mocked(tauriFetch)
const openedUrls = vi.mocked(openUrl)
const mockFlow = vi.mocked(runDeviceFlow)

/** Switch the step from the device-flow lead to PAT entry. */
async function switchToPat(): Promise<void> {
  fireEvent.click(
    await screen.findByRole('button', { name: /use a personal access token instead/i }),
  )
  await screen.findByLabelText('Personal access token')
}

/** Render with no stored credential and a flow that stays at the code view. */
async function renderCodeView(): Promise<void> {
  fakeKeychain()
  mockFlow.mockImplementation(async (options) => {
    options.onCode({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' })
    return new Promise(() => {}) // polling stays in flight
  })
  render(<GithubAuthStep onAuthed={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }))
  await screen.findByText('ABCD-1234')
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

afterEach(() => {
  cleanup()
  setBridge(null)
  httpFetch.mockReset()
  openedUrls.mockClear() // clear calls, keep the resolving implementation
  mockFlow.mockReset()
  Reflect.deleteProperty(navigator, 'clipboard')
})

function fakeKeychain(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  setBridge({
    invoke: async (command, args) => {
      const name = args['name'] as string
      if (command === 'secret_get') {
        return store.get(name) ?? null
      }
      if (command === 'secret_set') {
        store.set(name, args['value'] as string)
        return null
      }
      if (command === 'secret_delete') {
        store.delete(name)
        return null
      }
      throw new Error(`unexpected command ${command}`)
    },
    listen: async () => () => {},
  })
  return store
}

function githubAccepts(login: string): void {
  httpFetch.mockResolvedValue(
    new Response(JSON.stringify({ login }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

function githubRejects(): void {
  httpFetch.mockResolvedValue(
    new Response(JSON.stringify({ message: 'Bad credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('GithubAuthStep', () => {
  it('skips itself when a stored credential is still valid, reporting who', async () => {
    fakeKeychain({ 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) })
    githubAccepts('alex')
    const onAuthed = vi.fn()
    render(<GithubAuthStep onAuthed={onAuthed} />)

    await waitFor(() =>
      expect(onAuthed).toHaveBeenCalledWith({ login: 'alex', avatarUrl: null }),
    )
  })

  it('stores a pasted PAT, verifies it against GitHub, and reports the identity', async () => {
    const store = fakeKeychain()
    githubAccepts('alex')
    const onAuthed = vi.fn()
    render(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: '  github_pat_abc  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    await waitFor(() =>
      expect(onAuthed).toHaveBeenCalledWith({ login: 'alex', avatarUrl: null }),
    )
    expect(JSON.parse(store.get('github-auth') ?? '{}')).toEqual({
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
    render(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'github_pat_typo' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    expect(await screen.findByText(/rejected the token/i)).toBeTruthy()
    expect(onAuthed).not.toHaveBeenCalled()
    expect(store.has('github-auth')).toBe(false)
  })

  it('rejects an empty token with an inline message', async () => {
    fakeKeychain()
    const onAuthed = vi.fn()
    render(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    expect(await screen.findByText('Paste a token first.')).toBeTruthy()
    expect(onAuthed).not.toHaveBeenCalled()
  })

  it('names the backup repository in the token instructions when known', async () => {
    fakeKeychain()
    render(<GithubAuthStep onAuthed={vi.fn()} repoName="my-notes-backup" />)
    await switchToPat()

    expect(await screen.findByText('my-notes-backup')).toBeTruthy()
  })

  it('reports auth exactly once when the mount probe races a fresh sign-in', async () => {
    // A stored credential's mount-time probe is slow; the user saves a new
    // PAT meanwhile. Both paths complete — but the parent connects on every
    // onAuthed, so the late probe must be swallowed, not start a second run.
    fakeKeychain({ 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_old' }) })
    let resolveProbe: (response: Response) => void = () => {}
    httpFetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveProbe = resolve)),
    )
    httpFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ login: 'alex' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const onAuthed = vi.fn()
    render(<GithubAuthStep onAuthed={onAuthed} />)
    await switchToPat()

    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'github_pat_new' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1))

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
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    await renderCodeView()

    // GitHub's page asks for the code immediately, so the browser must not
    // open (and steal focus from the visible code) until it's in hand.
    expect(openedUrls).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Copy code and open GitHub' }))

    await waitFor(() =>
      expect(openedUrls).toHaveBeenCalledWith('https://github.com/login/device'),
    )
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
    expect(writeText.mock.invocationCallOrder[0]!).toBeLessThan(
      openedUrls.mock.invocationCallOrder[0]!,
    )
    expect(await screen.findByText(/code copied/i)).toBeTruthy()
  })

  it('surfaces the device URL when the browser cannot be opened', async () => {
    // The handoff URL appears only on failure — it is the one way left to
    // reach the page asking for the code.
    stubClipboard(vi.fn(async () => {}))
    openedUrls.mockRejectedValueOnce(new Error('no handler for https'))
    await renderCodeView()
    expect(screen.queryByText(/login\/device/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy code and open GitHub' }))

    expect(
      await screen.findByText(/visit https:\/\/github\.com\/login\/device yourself/i),
    ).toBeTruthy()
  })

  it('holds the GitHub handoff when the clipboard is unavailable', async () => {
    stubClipboard(async () => {
      throw new Error('denied')
    })
    await renderCodeView()

    fireEvent.click(screen.getByRole('button', { name: 'Copy code and open GitHub' }))

    // The user is told to copy by hand first; only then does GitHub open.
    expect(await screen.findByText(/select the code above/i)).toBeTruthy()
    expect(openedUrls).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub' }))
    await waitFor(() =>
      expect(openedUrls).toHaveBeenCalledWith('https://github.com/login/device'),
    )
  })
})
