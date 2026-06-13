import { useEffect, useRef, useState, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { isDeviceFlowConfigured, saveGithubAuth, type GithubUser } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAsyncAction } from '@/hooks/use-async-action'
import { useDeviceFlowAuth } from '@/hooks/use-device-flow-auth'
import { fetchSignedInUser } from '@/lib/github-account'
import { invalidateGithubAuth } from '@/lib/github-auth-state'

interface GithubAuthStepProps {
  /**
   * Fired with the verified identity once a credential is stored and GitHub
   * has confirmed it (or a valid one already was) — a mistyped token fails
   * right here, never at the first sync.
   */
  onAuthed: (user: GithubUser) => void
  /**
   * The backup repository the token should be scoped to, when the wizard
   * already knows it — the instructions name it instead of speaking
   * abstractly about "your backup repository".
   */
  repoName?: string
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The shared "sign in to GitHub" step (connect + restore dialogs): the guided
 * device flow when the GitHub App is registered, fine-grained-PAT entry
 * otherwise. Every path ends in a `GET /user` round-trip
 * ({@link fetchSignedInUser}), so the step only completes with a credential
 * GitHub actually accepts — and the caller learns *who* signed in, which the
 * wizard uses to connect `owner/name` without ever asking for the owner.
 */
export function GithubAuthStep({ onAuthed, repoName }: GithubAuthStepProps): ReactElement {
  const deviceFlow = useDeviceFlowAuth()
  const pat = useAsyncAction()
  const [patValue, setPatValue] = useState('')
  // The device flow leads when the app is registered; the PAT path stays one
  // click away (some users prefer a scoped token; GHES needs it).
  const [usePat, setUsePat] = useState(!isDeviceFlowConfigured())
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  /** Opening the browser failed — show the URL, the only way left to get there. */
  const [openFailed, setOpenFailed] = useState(false)
  const authedRef = useRef(false)

  // Auth can complete twice — the mount-time probe of a stored credential
  // racing a fresh sign-in — and the parent advances (and connects) on every
  // call, so completion must be single-shot.
  function reportAuthed(user: GithubUser): void {
    if (authedRef.current) {
      return
    }
    authedRef.current = true
    onAuthed(user)
  }

  // Already signed in with a working credential (e.g. connecting a second
  // graph) → skip the step. A stored-but-rejected credential is cleared by
  // fetchSignedInUser, so the step stays visible and explains itself.
  useEffect(() => {
    let cancelled = false
    void fetchSignedInUser()
      .then((user) => {
        if (!cancelled && user !== null) {
          reportAuthed(user)
        }
      })
      .catch(() => {
        // Leave the step visible; the user signs in fresh.
      })
    return () => {
      cancelled = true
    }
    // onAuthed is a parent callback; subscribing once on mount is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function verifyAndFinish(): Promise<void> {
    const user = await fetchSignedInUser()
    if (user === null) {
      throw new Error('GitHub rejected that token — check it and try again.')
    }
    reportAuthed(user)
  }

  async function signIn(): Promise<void> {
    setCopyState('idle') // each attempt mints a fresh code
    setOpenFailed(false)
    if (await deviceFlow.signIn()) {
      await pat.run(verifyAndFinish)
    }
  }

  /**
   * The code goes to the clipboard *before* the browser opens — GitHub's
   * device page asks for it immediately, and once the browser has focus the
   * code in this dialog is out of sight. If copying isn't possible, hold the
   * handoff and have the user copy by hand first.
   */
  async function copyCodeAndOpen(flow: { userCode: string; verificationUri: string }): Promise<void> {
    if (copyState !== 'failed') {
      try {
        await navigator.clipboard.writeText(flow.userCode)
        setCopyState('copied')
      } catch {
        setCopyState('failed')
        return
      }
    }
    setOpenFailed(false)
    void openUrl(flow.verificationUri).catch(() => {
      setOpenFailed(true)
    })
  }

  async function savePat(): Promise<void> {
    const token = patValue.trim()
    if (token.length === 0) {
      pat.setError('Paste a token first.')
      return
    }
    // Keychain writes can fail (locked keychain, denied access) and GitHub
    // can reject the token — the action envelope surfaces both inline.
    await pat.run(async () => {
      await saveGithubAuth({ kind: 'pat', token })
      invalidateGithubAuth()
      await verifyAndFinish()
    })
  }

  const error = deviceFlow.error ?? pat.error
  const flowView = deviceFlow.view

  return (
    <div className="flex flex-col gap-3">
      {flowView.view === 'idle' ? (
        !usePat ? (
          <>
            <Button
              onClick={() => void signIn()}
              disabled={deviceFlow.busy || pat.pending}
              size="sm"
            >
              Sign in with GitHub
            </Button>
            <button
              type="button"
              className="text-left text-xs text-text-muted underline"
              onClick={() => setUsePat(true)}
            >
              Use a personal access token instead
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-text-muted">
              Paste a fine-grained personal access token with <strong>Contents</strong> read/write
              access to{' '}
              {repoName !== undefined ? (
                <>
                  the <strong>{repoName}</strong> repository
                </>
              ) : (
                'your backup repository'
              )}{' '}
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
              {pat.pending ? 'Checking…' : 'Save token'}
            </Button>
            {isDeviceFlowConfigured() ? (
              <button
                type="button"
                className="text-left text-xs text-text-muted underline"
                onClick={() => setUsePat(false)}
              >
                Sign in with GitHub instead
              </button>
            ) : null}
          </>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-muted">
            {copyState === 'copied'
              ? 'Code copied — paste it on the GitHub page:'
              : 'GitHub will ask for this one-time code:'}
          </p>
          <p className="select-text text-center font-mono text-xl tracking-[0.3em] text-text">
            {flowView.userCode}
          </p>
          <Button size="sm" onClick={() => void copyCodeAndOpen(flowView)}>
            {copyState === 'failed' ? 'Open GitHub' : 'Copy code and open GitHub'}
          </Button>
          {copyState === 'failed' ? (
            <p className="text-xs text-text-muted">
              Couldn’t copy automatically — select the code above and copy it first.
            </p>
          ) : null}
          {openFailed ? (
            <p className="select-text text-xs text-text-muted">
              Couldn’t open the browser — visit {flowView.verificationUri} yourself.
            </p>
          ) : null}
        </div>
      )}
      {error !== null ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    </div>
  )
}
