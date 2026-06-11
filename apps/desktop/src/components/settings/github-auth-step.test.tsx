import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { GithubAuthStep } from './github-auth-step'

// The Reflect GitHub App is registered, so the device flow leads and the PAT
// path sits behind a "use a personal access token instead" toggle — these
// tests exercise the PAT path through that toggle. The keychain is the
// bridge fake; GET /user (instant token validation) goes through the mocked
// Tauri HTTP plugin.

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

/** Switch the step from the device-flow lead to PAT entry. */
async function switchToPat(): Promise<void> {
  fireEvent.click(
    await screen.findByRole('button', { name: /use a personal access token instead/i }),
  )
  await screen.findByLabelText('Personal access token')
}

afterEach(() => {
  cleanup()
  setBridge(null)
  httpFetch.mockReset()
})

function fakeKeychain(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  setBridge({
    invoke: async (command, args) => {
      const name = args.name as string
      if (command === 'secret_get') {
        return store.get(name) ?? null
      }
      if (command === 'secret_set') {
        store.set(name, args.value as string)
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
})
