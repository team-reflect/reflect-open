import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/** What a device-flow surface renders: nothing yet, or the code to enter. */
export type DeviceFlowView =
  | { view: 'idle' }
  | { view: 'code'; userCode: string; verificationUri: string }

export interface DeviceFlowAuth {
  view: DeviceFlowView
  busy: boolean
  error: string | null
  /**
   * Run the device flow: GitHub issues a code (surfaced via `view`), then
   * polling waits for the user to enter it. The browser is *not* opened
   * here — the surface does that after the user has the code in hand, so
   * the page asking for the code never steals focus from the code itself.
   * Resolves `true` once the credential is stored in the keychain, `false`
   * on failure (the error is in `error`) or unmount.
   */
  signIn: () => Promise<boolean>
}

/**
 * The GitHub device-flow state machine, separated from rendering so any
 * surface (the connect dialog, restore, a future onboarding screen) can drive
 * the same auth. Polling policy lives further down in core's
 * `GithubAuthService.runDeviceFlow`; this hook owns the React side: the
 * view/busy/error states and aborting the poll when the owning component
 * unmounts.
 */
export function useDeviceFlowAuth(): DeviceFlowAuth {
  const { githubAuth } = useCoreServices()
  const [view, setView] = useState<DeviceFlowView>({ view: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One controller per *mount*, created in the effect: a ref-initialized
  // controller would be aborted once by StrictMode's probe unmount and the
  // surviving instance would then poll with a dead signal forever (the code
  // renders, polling never starts).
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    abortRef.current = abort
    return () => {
      abort.abort() // closing the dialog stops the device-flow polling
    }
  }, [])

  async function signIn(): Promise<boolean> {
    setError(null)
    setBusy(true)
    let signedIn = false
    try {
      const signal = abortRef.current?.signal
      const auth = await githubAuth.runDeviceFlow({
        signal,
        onCode: (code) => {
          setView({ view: 'code', userCode: code.userCode, verificationUri: code.verificationUri })
        },
      })
      signedIn = auth !== null
    } catch (caught: unknown) {
      setView({ view: 'idle' })
      setError(errorMessage(caught))
    }
    // The catch swallows everything, so this always runs. No `finally`: the
    // React Compiler skips any function that has one.
    setBusy(false)
    return signedIn
  }

  return { view, busy, error, signIn }
}
