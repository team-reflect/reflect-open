import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { GithubAuthStep } from './github-auth-step'

// The device flow is unconfigured in OSS builds (no app client id), so the
// step renders the PAT path — exactly what these tests exercise. The keychain
// is the bridge fake below.

afterEach(() => {
  cleanup()
  setBridge(null)
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
      throw new Error(`unexpected command ${command}`)
    },
    listen: async () => () => {},
  })
  return store
}

describe('GithubAuthStep', () => {
  it('skips itself when a credential is already stored', async () => {
    fakeKeychain({ 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) })
    const onAuthed = vi.fn()
    render(<GithubAuthStep onAuthed={onAuthed} />)

    await waitFor(() => expect(onAuthed).toHaveBeenCalled())
  })

  it('stores a pasted PAT in the keychain and reports authed', async () => {
    const store = fakeKeychain()
    const onAuthed = vi.fn()
    render(<GithubAuthStep onAuthed={onAuthed} />)

    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: '  github_pat_abc  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    await waitFor(() => expect(onAuthed).toHaveBeenCalled())
    expect(JSON.parse(store.get('github-auth') ?? '{}')).toEqual({
      kind: 'pat',
      token: 'github_pat_abc',
    })
  })

  it('rejects an empty token with an inline message', async () => {
    fakeKeychain()
    const onAuthed = vi.fn()
    render(<GithubAuthStep onAuthed={onAuthed} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    expect(await screen.findByText('Paste a token first.')).toBeTruthy()
    expect(onAuthed).not.toHaveBeenCalled()
  })
})
