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
 * The mobile first-run screen (Plans 19/21) — shown until the user picks
 * where their notes live, gated by the `mobileOnboarded` setting in
 * {@link GraphProvider}.
 *
 * iCloud Drive leads (Plan 21): it is the primary way a graph syncs between
 * iPhone and Mac, so the hero action opens the app's iCloud container —
 * labelled "Open your iCloud notes" when the container already holds notes
 * from another device. **Keep notes on this device** opens the app-sandbox
 * root instead (and is promoted to the only storage button when iCloud is
 * unavailable). Git users can still connect from the **Sync with GitHub
 * instead** link: the shared device flow ({@link GithubAuthStep}), then a
 * clone *straight into* the local root — `git_clone` refuses a non-empty
 * directory, so this only works while that root is untouched, which is
 * exactly why the provider defers opening until now. Every path ends in
 * `completeOnboarding(kind)`, which opens the chosen root and records the
 * flag + storage kind.
 */
export function MobileOnboardingScreen(): ReactElement {
  const { mobileStorageInfo, completeOnboarding } = useGraph()
  const action = useAsyncAction()
  const [step, setStep] = useState<Step>('choose')
  const [repoInput, setRepoInput] = useState('')
  const [user, setUser] = useState<GithubUser | null>(null)

  const icloudReady = mobileStorageInfo?.icloudRoot != null
  const hasIcloudNotes = mobileStorageInfo?.icloudHasGraph === true

  function storeInIcloud(): void {
    void action.run(() => completeOnboarding('icloud'))
  }

  function keepOnDevice(): void {
    void action.run(() => completeOnboarding('local'))
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
    const localRoot = mobileStorageInfo?.localRoot ?? null
    if (localRoot === null) {
      action.setError('No graph folder available.')
      return
    }
    void action.run(async () => {
      const token = await getGithubToken(providerFetch)
      if (token === null) {
        throw new ReflectError('auth', 'Sign in to GitHub first')
      }
      await gitClone(githubRemoteUrl(ref), localRoot, token)
      // Opens the clone (a 'local' graph); the index rebuilds from the files.
      await completeOnboarding('local')
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
            ? 'Your notes are plain markdown files. Choose where to keep them.'
            : 'Sign in to GitHub, then choose the repository to download.'}
        </p>
      </div>

      {step === 'choose' ? (
        <div className="flex flex-col gap-3">
          {icloudReady ? (
            <div className="flex flex-col gap-1.5">
              <Button onClick={storeInIcloud} disabled={action.pending}>
                {action.pending
                  ? 'Setting up…'
                  : hasIcloudNotes
                    ? 'Open your iCloud notes'
                    : 'Store in iCloud Drive'}
              </Button>
              <p className="text-center text-xs text-text-muted">
                {hasIcloudNotes
                  ? 'We found notes in your iCloud Drive.'
                  : 'Recommended — syncs with Reflect on your other devices.'}
              </p>
            </div>
          ) : null}
          <Button
            variant={icloudReady ? 'outline' : 'default'}
            onClick={keepOnDevice}
            disabled={action.pending}
          >
            {action.pending ? 'Setting up…' : 'Keep notes on this device'}
          </Button>
          {!icloudReady ? (
            <p className="text-center text-xs text-text-muted">
              Sign in to iCloud on this device to sync notes with iCloud Drive.
            </p>
          ) : null}
          <LinkButton onClick={() => setStep('auth')} disabled={action.pending}>
            Sync with GitHub instead
          </LinkButton>
        </div>
      ) : step === 'auth' ? (
        <div className="flex flex-col gap-3">
          <GithubAuthStep
            onAuthed={(authedUser) => {
              setUser(authedUser)
              setStep('repo')
            }}
          />
          <LinkButton onClick={() => setStep('choose')} disabled={action.pending}>
            Back
          </LinkButton>
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
          <LinkButton onClick={() => setStep('choose')} disabled={action.pending}>
            Back
          </LinkButton>
        </div>
      )}

      {action.error !== null ? <InlineAlert tone="error">{action.error}</InlineAlert> : null}
    </div>
  )
}

function LinkButton({
  children,
  onClick,
  disabled,
}: {
  children: string
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
      {children}
    </button>
  )
}
