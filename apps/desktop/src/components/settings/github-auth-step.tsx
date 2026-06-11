import { useEffect, useState, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { isDeviceFlowConfigured, loadGithubAuth, saveGithubAuth } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAsyncAction } from '@/hooks/use-async-action'
import { useDeviceFlowAuth } from '@/hooks/use-device-flow-auth'

interface GithubAuthStepProps {
  /** Fired once a credential is stored (or one already was). */
  onAuthed: () => void
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The shared "sign in to GitHub" step (connect + restore dialogs): the guided
 * device flow when the GitHub App is registered, fine-grained-PAT entry
 * otherwise. All the machinery lives in hooks ({@link useDeviceFlowAuth},
 * {@link useAsyncAction}) — this component only renders their states.
 */
export function GithubAuthStep({ onAuthed }: GithubAuthStepProps): ReactElement {
  const deviceFlow = useDeviceFlowAuth()
  const pat = useAsyncAction()
  const [patValue, setPatValue] = useState('')

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

  async function signIn(): Promise<void> {
    if (await deviceFlow.signIn()) {
      onAuthed()
    }
  }

  async function savePat(): Promise<void> {
    const token = patValue.trim()
    if (token.length === 0) {
      pat.setError('Paste a token first.')
      return
    }
    // Keychain writes can fail (locked keychain, denied access) — the action
    // envelope surfaces it inline instead of an unhandled rejection.
    await pat.run(async () => {
      await saveGithubAuth({ kind: 'pat', token })
      onAuthed()
    })
  }

  const error = deviceFlow.error ?? pat.error
  const flowView = deviceFlow.view

  return (
    <div className="flex flex-col gap-3">
      {flowView.view === 'idle' ? (
        isDeviceFlowConfigured() ? (
          <Button onClick={() => void signIn()} disabled={deviceFlow.busy} size="sm">
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
            <Button onClick={() => void savePat()} disabled={pat.pending} size="sm">
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
              onClick={() => void openUrl(flowView.verificationUri)}
            >
              {flowView.verificationUri}
            </button>
            :
          </p>
          <p className="text-center font-mono text-xl tracking-[0.3em] text-text">
            {flowView.userCode}
          </p>
          <p className="text-center text-xs text-text-muted">Waiting for GitHub…</p>
        </div>
      )}
      {error !== null ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    </div>
  )
}
