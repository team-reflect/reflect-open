import { useState, type ReactElement } from 'react'
import {
  getGithubToken,
  githubRemoteUrl,
  gitClone,
  ReflectError,
  type GithubUser,
} from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { GithubAuthStep } from '@/components/settings/github-auth-step'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAsyncAction } from '@/hooks/use-async-action'
import { parseRepoInput } from '@/lib/github-repos'
import { providerFetch } from '@/lib/provider-fetch'
import { useGraph } from '@/providers/graph-provider'

type Step = 'choose' | 'auth' | 'repo'

/**
 * The mobile first-run screen (Plan 19, step 6) — shown until the user picks
 * how to start, gated by the `mobileOnboarded` setting in {@link GraphProvider}.
 *
 * **Start fresh** opens the empty fixed root, which bootstraps a new graph
 * (and seeds the welcome note). **Connect to GitHub** signs in with the shared
 * device flow ({@link GithubAuthStep}), then clones the chosen backup repo
 * *straight into* the fixed root — `git_clone` refuses a non-empty directory,
 * so this only works while the root is still untouched, which is exactly why
 * the provider defers opening until now. Both paths end in
 * `completeOnboarding`, which opens the root and records the flag.
 */
export function MobileOnboardingScreen(): ReactElement {
  const { mobileRoot, completeOnboarding } = useGraph()
  const action = useAsyncAction()
  const [step, setStep] = useState<Step>('choose')
  const [repoInput, setRepoInput] = useState('')
  const [user, setUser] = useState<GithubUser | null>(null)

  function startFresh(): void {
    void action.run(completeOnboarding)
  }

  function downloadAndOpen(): void {
    // A bare name belongs to the signed-in account — the common case never
    // needs the owner typed (mirrors the desktop restore dialog).
    const trimmed = repoInput.trim()
    const normalized =
      !trimmed.includes('/') && trimmed.length > 0 && user !== null
        ? `${user.login}/${trimmed}`
        : trimmed
    const ref = parseRepoInput(normalized)
    if (ref === null) {
      action.setError('Enter the repository name (or owner/name for another account).')
      return
    }
    if (mobileRoot === null) {
      action.setError('No graph folder available.')
      return
    }
    void action.run(async () => {
      const token = await getGithubToken(providerFetch)
      if (token === null) {
        throw new ReflectError('auth', 'Sign in to GitHub first')
      }
      await gitClone(githubRemoteUrl(ref), mobileRoot, token)
      await completeOnboarding() // opens the clone; the index rebuilds from the files
    })
  }

  return (
    <div
      className="flex h-dvh w-screen flex-col justify-center gap-6 px-8"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)',
      }}
    >
      <div className="flex flex-col gap-1.5 text-center">
        <h1 className="text-lg font-semibold">Welcome to Reflect</h1>
        <p className="text-sm text-text-muted">
          {step === 'choose'
            ? 'Start a new graph, or connect one you already back up to GitHub.'
            : 'Sign in to GitHub, then choose the repository to download.'}
        </p>
      </div>

      {step === 'choose' ? (
        <div className="flex flex-col gap-2">
          <Button onClick={startFresh} disabled={action.pending}>
            {action.pending ? 'Setting up…' : 'Start fresh'}
          </Button>
          <Button variant="outline" onClick={() => setStep('auth')} disabled={action.pending}>
            Connect to GitHub
          </Button>
        </div>
      ) : step === 'auth' ? (
        <div className="flex flex-col gap-3">
          <GithubAuthStep
            onAuthed={(authedUser) => {
              setUser(authedUser)
              setStep('repo')
            }}
          />
          <BackLink onClick={() => setStep('choose')} disabled={action.pending} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-secondary">Backup repository</span>
            <Input
              autoFocus
              value={repoInput}
              onChange={(event) => setRepoInput(event.target.value)}
              placeholder={user !== null ? `${user.login}/…` : 'owner/name'}
            />
          </label>
          <Button onClick={downloadAndOpen} disabled={action.pending}>
            {action.pending ? 'Downloading…' : 'Download & open'}
          </Button>
          <BackLink onClick={() => setStep('choose')} disabled={action.pending} />
        </div>
      )}

      {action.error !== null ? <InlineAlert tone="error">{action.error}</InlineAlert> : null}
    </div>
  )
}

function BackLink({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      className="text-center text-xs text-text-muted underline disabled:opacity-50"
      onClick={onClick}
      disabled={disabled}
    >
      Back
    </button>
  )
}
