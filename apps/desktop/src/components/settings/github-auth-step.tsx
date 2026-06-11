import { useEffect, useRef, useState, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  errorMessage,
  isDeviceFlowConfigured,
  loadGithubAuth,
  runDeviceFlow,
  saveGithubAuth,
} from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { providerFetch } from '@/lib/provider-fetch'

interface GithubAuthStepProps {
  /** Fired once a credential is stored (or one already was). */
  onAuthed: () => void
}

type View = { view: 'choose' } | { view: 'device'; userCode: string; verificationUri: string }

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The shared "sign in to GitHub" step (connect + restore dialogs): the guided
 * device flow when the GitHub App is registered, fine-grained-PAT entry
 * otherwise. The polling loop itself is core's `runDeviceFlow` — this
 * component only renders its states and aborts it on unmount.
 */
export function GithubAuthStep({ onAuthed }: GithubAuthStepProps): ReactElement {
  const [view, setView] = useState<View>({ view: 'choose' })
  const [patValue, setPatValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const abortRef = useRef(new AbortController())

  // Already signed in (e.g. connecting a second graph) → skip the step.
  useEffect(() => {
    let cancelled = false
    void loadGithubAuth().then((auth) => {
      if (!cancelled && auth !== null) {
        onAuthed()
      }
    })
    return () => {
      cancelled = true
    }
    // onAuthed is a parent callback; subscribing once on mount is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const abort = abortRef.current
    return () => {
      abort.abort() // closing the dialog stops the device-flow polling
    }
  }, [])

  async function signInWithDeviceFlow(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const auth = await runDeviceFlow({
        fetchFn: providerFetch,
        signal: abortRef.current.signal,
        onCode: (code) => {
          setView({ view: 'device', userCode: code.userCode, verificationUri: code.verificationUri })
          void openUrl(code.verificationUri).catch(() => {
            // The URI is shown in the dialog; failing to auto-open is cosmetic.
          })
        },
      })
      if (auth !== null) {
        onAuthed()
      }
    } catch (caught: unknown) {
      setView({ view: 'choose' })
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function savePat(): Promise<void> {
    const token = patValue.trim()
    if (token.length === 0) {
      setError('Paste a token first.')
      return
    }
    setError(null)
    try {
      await saveGithubAuth({ kind: 'pat', token })
      onAuthed()
    } catch (caught: unknown) {
      // Keychain writes can fail (locked keychain, denied access) — surface
      // it here instead of an unhandled rejection.
      setError(errorMessage(caught))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {view.view === 'choose' ? (
        isDeviceFlowConfigured() ? (
          <Button onClick={() => void signInWithDeviceFlow()} disabled={busy} size="sm">
            Sign in with GitHub
          </Button>
        ) : (
          <>
            <p className="text-xs text-text-muted">
              Paste a fine-grained personal access token with <strong>Contents</strong> and{' '}
              <strong>Administration</strong> read/write access to your backup repository
              (GitHub → Settings → Developer settings → Fine-grained tokens). It is stored in
              your OS keychain, never in your graph.
            </p>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Personal access token</span>
              <Input
                autoFocus
                type="password"
                value={patValue}
                onChange={(event) => setPatValue(event.target.value)}
                placeholder="github_pat_…"
              />
            </label>
            <Button onClick={() => void savePat()} disabled={busy} size="sm">
              Save token
            </Button>
          </>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-muted">
            Enter this code at{' '}
            <button
              type="button"
              className="underline"
              onClick={() => void openUrl(view.verificationUri)}
            >
              {view.verificationUri}
            </button>
            :
          </p>
          <p className="text-center font-mono text-xl tracking-[0.3em] text-text">
            {view.userCode}
          </p>
          <p className="text-center text-xs text-text-muted">Waiting for GitHub…</p>
        </div>
      )}
      {error !== null ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    </div>
  )
}
