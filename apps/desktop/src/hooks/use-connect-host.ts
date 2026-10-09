import { useState } from 'react'
import type { GitCredential } from '@reflect/core'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useSync } from '@/providers/sync-provider.tsx'

export interface ConnectHostForm {
  url: string
  setUrl: (url: string) => void
  username: string
  setUsername: (username: string) => void
  token: string
  setToken: (token: string) => void
  pending: boolean
  error: string | null
  /** Validate the fields, then check the sign-in against the host, store it, and connect. */
  submit: () => Promise<void>
}

/**
 * The "Connect another host" form: a repository URL on GitLab, Gitea,
 * Codeberg, or a server of your own, plus the username and token the host
 * expects over HTTPS. Desktop's dialog and mobile's drawer render this one
 * state; the controller's `connectHost` does the work (it refuses a URL it
 * cannot connect, then probes, so a wrong URL or token fails here with the
 * host's own answer and nothing is stored). `initialUrl` prefills the form
 * for a graph whose remote is set and only lacks a working sign-in. `onClose`
 * runs once the graph is connected.
 */
export function useConnectHost(onClose: () => void, initialUrl = ''): ConnectHostForm {
  const { connectHost } = useSync()
  const action = useAsyncAction()
  const [url, setUrl] = useState(initialUrl)
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')

  async function submit(): Promise<void> {
    const remoteUrl = url.trim()
    const credential: GitCredential = { username: username.trim(), secret: token.trim() }
    if (credential.username === '' || credential.secret === '') {
      action.setError('Enter the username and token the host expects.')
      return
    }
    await action.run(async () => {
      await connectHost(remoteUrl, credential)
      onClose()
    })
  }

  return {
    url,
    setUrl,
    username,
    setUsername,
    token,
    setToken,
    pending: action.pending,
    error: action.error,
    submit,
  }
}
