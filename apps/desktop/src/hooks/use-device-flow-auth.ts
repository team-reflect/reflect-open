import { useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { errorMessage, runDeviceFlow } from '@reflect/core'
import { providerFetch } from '@/lib/provider-fetch'

/** What a device-flow surface renders: nothing yet, or the code to enter. */
export type DeviceFlowView =
  | { view: 'idle' }
  | { view: 'code'; userCode: string; verificationUri: string }

export interface DeviceFlowAuth {
  view: DeviceFlowView
  busy: boolean
  error: string | null
  /**
   * Run the device flow: GitHub issues a code (surfaced via `view` and
   * auto-opened in the browser), then polling waits for the user to enter
   * it. Resolves `true` once the credential is stored in the keychain,
   * `false` on failure (the error is in `error`) or unmount.
   */
  signIn: () => Promise<boolean>
}

/**
 * The GitHub device-flow state machine, separated from rendering so any
 * surface (the connect dialog, restore, a future onboarding screen) can drive
 * the same auth. Polling policy lives further down in core's `runDeviceFlow`;
 * this hook owns the React side: the view/busy/error states and aborting the
 * poll when the owning component unmounts.
 */
export function useDeviceFlowAuth(): DeviceFlowAuth {
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
    try {
      const auth = await runDeviceFlow({
        fetchFn: providerFetch,
        signal: abortRef.current?.signal,
        onCode: (code) => {
          setView({ view: 'code', userCode: code.userCode, verificationUri: code.verificationUri })
          void openUrl(code.verificationUri).catch(() => {
            // The URI is shown in the dialog; failing to auto-open is cosmetic.
          })
        },
      })
      return auth !== null
    } catch (caught: unknown) {
      setView({ view: 'idle' })
      setError(errorMessage(caught))
      return false
    } finally {
      setBusy(false)
    }
  }

  return { view, busy, error, signIn }
}
