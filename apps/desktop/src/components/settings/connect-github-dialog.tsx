import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  deviceFlowPoll,
  deviceFlowStart,
  errorMessage,
  isDeviceFlowConfigured,
  loadGithubAuth,
  parseGithubRemote,
  saveGithubAuth,
  type GithubRepoRef,
} from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { providerFetch } from '@/lib/provider-fetch'
import { useSync } from '@/providers/sync-provider'

interface ConnectGithubDialogProps {
  /** A suggested name for a newly created backup repo (from the graph name). */
  suggestedRepoName: string
  onClose: () => void
}

type Step =
  | { step: 'auth' }
  | { step: 'device'; userCode: string; verificationUri: string }
  | { step: 'repo' }

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/** Parse "owner/name" or a full GitHub URL into a repo ref. */
function parseRepoInput(input: string): GithubRepoRef | null {
  const trimmed = input.trim()
  const fromUrl = parseGithubRemote(trimmed)
  if (fromUrl !== null) {
    return fromUrl
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed)
  return match === null ? null : { owner: match[1], name: match[2] }
}

/**
 * The "Connect GitHub" modal: sign in (device flow when the GitHub App is
 * registered, fine-grained PAT entry otherwise), then pick the backup repo —
 * create a new **private** one (the default) or connect an existing one.
 * Connecting a public repo demands explicit confirmation: every note in the
 * graph, including `private: true` ones, would be world-readable.
 */
export function ConnectGithubDialog({
  suggestedRepoName,
  onClose,
}: ConnectGithubDialogProps): ReactElement {
  const { connectNewRepo, connectExistingRepo } = useSync()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>({ step: 'auth' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [patValue, setPatValue] = useState('')
  const [mode, setMode] = useState<'create' | 'existing'>('create')
  const [repoName, setRepoName] = useState(suggestedRepoName)
  const [existingRepo, setExistingRepo] = useState('')
  const [publicConfirm, setPublicConfirm] = useState<GithubRepoRef | null>(null)

  // Already signed in (e.g. reconnecting a second graph) → skip straight to
  // the repo step.
  useEffect(() => {
    let cancelled = false
    void loadGithubAuth().then((auth) => {
      if (!cancelled && auth !== null) {
        setStep({ step: 'repo' })
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Device-flow polling loop; cancelled if the dialog closes mid-flow.
  const pollAbort = useRef(false)
  useEffect(
    () => () => {
      pollAbort.current = true
    },
    [],
  )

  async function startDeviceFlow(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const flow = await deviceFlowStart(providerFetch)
      setStep({ step: 'device', userCode: flow.userCode, verificationUri: flow.verificationUri })
      void openUrl(flow.verificationUri).catch(() => {
        // The URI is shown in the dialog; failing to auto-open is cosmetic.
      })
      let intervalSeconds = flow.intervalSeconds
      const deadline = Date.now() + flow.expiresInSeconds * 1000
      while (!pollAbort.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000))
        if (pollAbort.current) {
          return
        }
        const result = await deviceFlowPoll(flow.deviceCode, providerFetch)
        if (result.status === 'pending') {
          continue
        }
        if (result.status === 'slowDown') {
          intervalSeconds = result.intervalSeconds
          continue
        }
        if (result.status === 'authorized') {
          await saveGithubAuth(result.auth)
          setStep({ step: 'repo' })
          return
        }
        setStep({ step: 'auth' })
        setError(result.status === 'denied' ? 'GitHub sign-in was denied.' : 'The code expired — try again.')
        return
      }
      // The deadline passed while GitHub still reported the code as pending —
      // don't leave the dialog stuck on "Waiting for GitHub…".
      if (!pollAbort.current) {
        setStep({ step: 'auth' })
        setError('The code expired — try again.')
      }
    } catch (caught: unknown) {
      setStep({ step: 'auth' })
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
    await saveGithubAuth({ kind: 'pat', token })
    setStep({ step: 'repo' })
  }

  async function connect(allowPublic = false): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      if (mode === 'create') {
        const name = repoName.trim()
        if (name.length === 0) {
          setError('Name the new repository.')
          return
        }
        await connectNewRepo(name)
        onClose()
        return
      }
      const ref = publicConfirm ?? parseRepoInput(existingRepo)
      if (ref === null) {
        setError('Enter the repository as owner/name or a GitHub URL.')
        return
      }
      const result = await connectExistingRepo(ref, { allowPublic })
      if (result === 'notFound') {
        setError('That repository was not found (check the name and the token’s repo access).')
        return
      }
      if (result === 'needsPublicConfirm') {
        setPublicConfirm(ref)
        return
      }
      onClose()
    } catch (caught: unknown) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[18vh]"
      onPointerDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect GitHub"
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-4 shadow-lg"
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onKeyDown={handleDialogKeyDown}
      >
        <h2 className="text-sm font-semibold text-text">Connect GitHub</h2>

        {step.step === 'auth' ? (
          <div className="mt-3 flex flex-col gap-3">
            {isDeviceFlowConfigured() ? (
              <Button onClick={() => void startDeviceFlow()} disabled={busy} size="sm">
                Sign in with GitHub
              </Button>
            ) : (
              <>
                <p className="text-xs text-text-muted">
                  Paste a fine-grained personal access token with <strong>Contents</strong> and{' '}
                  <strong>Administration</strong> read/write access to your backup repository
                  (GitHub → Settings → Developer settings → Fine-grained tokens). It is stored
                  in your OS keychain, never in your graph.
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
            )}
          </div>
        ) : null}

        {step.step === 'device' ? (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-xs text-text-muted">
              Enter this code at{' '}
              <button
                type="button"
                className="underline"
                onClick={() => void openUrl(step.verificationUri)}
              >
                {step.verificationUri}
              </button>
              :
            </p>
            <p className="text-center font-mono text-xl tracking-[0.3em] text-text">
              {step.userCode}
            </p>
            <p className="text-center text-xs text-text-muted">Waiting for GitHub…</p>
          </div>
        ) : null}

        {step.step === 'repo' ? (
          <div className="mt-3 flex flex-col gap-3">
            {publicConfirm === null ? (
              <>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="radio"
                      checked={mode === 'create'}
                      onChange={() => setMode('create')}
                    />
                    Create a new private repository
                  </label>
                  {mode === 'create' ? (
                    <Input
                      autoFocus
                      value={repoName}
                      onChange={(event) => setRepoName(event.target.value)}
                      className="ml-6 w-auto"
                      aria-label="New repository name"
                    />
                  ) : null}
                  <label className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="radio"
                      checked={mode === 'existing'}
                      onChange={() => setMode('existing')}
                    />
                    Use an existing repository
                  </label>
                  {mode === 'existing' ? (
                    <Input
                      autoFocus
                      value={existingRepo}
                      onChange={(event) => setExistingRepo(event.target.value)}
                      placeholder="owner/name"
                      className="ml-6 w-auto"
                      aria-label="Existing repository"
                    />
                  ) : null}
                </div>
                <Button onClick={() => void connect()} disabled={busy} size="sm">
                  {busy ? 'Connecting…' : 'Connect'}
                </Button>
              </>
            ) : (
              <>
                <InlineAlert tone="error">
                  <strong>
                    {publicConfirm.owner}/{publicConfirm.name} is public.
                  </strong>{' '}
                  Everything in this graph — including notes marked private — would be readable
                  by anyone on the internet.
                </InlineAlert>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPublicConfirm(null)}>
                    Choose another repo
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void connect(true)}
                    disabled={busy}
                  >
                    Back up to a public repo
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {error !== null ? (
          <InlineAlert tone="error" className="mt-3">
            {error}
          </InlineAlert>
        ) : null}
      </div>
    </div>
  )
}
