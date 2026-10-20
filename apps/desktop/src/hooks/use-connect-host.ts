import { useState } from 'react'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useGitSync } from '@/providers/sync-provider.tsx'

export interface ConnectHostForm {
  remoteUrl: string
  setRemoteUrl: (value: string) => void
  username: string
  setUsername: (value: string) => void
  token: string
  setToken: (value: string) => void
  pending: boolean
  error: string | null
  /**
   * Connect with the current fields; resolves `true` once connected. A
   * refusal lands in `error` and keeps the fields.
   */
  submit: () => Promise<boolean>
}

/**
 * The "Another host" form: a repository URL, a username and an access token
 * for an HTTPS git host other than github.com. The connect itself is the
 * graph's host connector; this owns the fields and the busy/error envelope,
 * so desktop's dialog and mobile's drawer render the same flow.
 */
export function useConnectHost(initialRemoteUrl = ''): ConnectHostForm {
  const { connectHost } = useGitSync()
  const action = useAsyncAction()
  const [remoteUrl, setRemoteUrl] = useState(initialRemoteUrl)
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')

  async function submit(): Promise<boolean> {
    let connected = false
    await action.run(async () => {
      await connectHost({ remoteUrl, username, token })
      connected = true
    })
    return connected
  }

  return {
    remoteUrl,
    setRemoteUrl,
    username,
    setUsername,
    token,
    setToken,
    pending: action.pending,
    error: action.error,
    submit,
  }
}
