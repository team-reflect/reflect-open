import { useId, useState, type ReactElement } from 'react'
import {
  getGithubToken,
  githubRemoteUrl,
  gitClone,
  ReflectError,
  type GithubUser,
} from '@reflect/core'
import { Cloud, FolderOpen, GitBranch, HardDrive, Plus } from 'lucide-react'
import { InlineAlert } from '@/components/inline-alert'
import { GithubAuthStep } from '@/components/settings/github-auth-step'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAsyncAction } from '@/hooks/use-async-action'
import {
  cleanGraphName,
  graphNameFromRoot,
  graphRootForName,
  isGraphNameTaken,
} from '@/lib/graph-names'
import { parseRepoInput } from '@/lib/github-repos'
import { providerFetch } from '@/lib/provider-fetch'
import { useGraph } from '@/providers/graph-provider'

type Step = 'choose' | 'auth' | 'repo'

/** Which control kicked off the in-flight choice, so only that one shows the
 * spinner/pending label (every button still disables). Container graph roots
 * are absolute paths, so the fixed tags can never collide with one. */
type PendingChoice = string | 'icloud-create' | 'local' | 'clone' | null

/**
 * The mobile first-run screen (Plans 19/21) — shown until the user picks
 * where their notes live, gated by the `mobileOnboarded` setting in
 * {@link GraphProvider}.
 *
 * iCloud Drive leads (Plan 21): it is the primary way a graph syncs between
 * iPhone and Mac, so the hero block lists every graph already in the app's
 * iCloud container (one tap opens it — the container can hold several), plus
 * a create row for a new container graph. **Keep notes on this device** opens
 * the app-sandbox root instead (and is promoted to the only storage button
 * when iCloud is unavailable). Git users can still connect from the **Sync
 * with GitHub instead** link: the shared device flow ({@link GithubAuthStep}),
 * then a clone *straight into* the local root — `git_clone` refuses a
 * non-empty directory, so this only works while that root is untouched, which
 * is exactly why the provider defers opening until now. Every path ends in
 * `completeOnboarding(kind, root)`, which opens the chosen root and records
 * the flag + storage kind + graph name.
 */
export function MobileOnboardingScreen(): ReactElement {
  const { mobileStorageInfo, completeOnboarding } = useGraph()
  const action = useAsyncAction()
  const [step, setStep] = useState<Step>('choose')
  const [pendingChoice, setPendingChoice] = useState<PendingChoice>(null)
  const [typedIcloudName, setTypedIcloudName] = useState<string | null>(null)
  const [repoInput, setRepoInput] = useState('')
  const [user, setUser] = useState<GithubUser | null>(null)
  const icloudNameId = useId()

  const icloudDocumentsRoot = mobileStorageInfo?.icloudDocumentsRoot ?? null
  const icloudReady = icloudDocumentsRoot !== null
  const icloudGraphs = mobileStorageInfo?.icloudGraphRoots ?? []
  // "Notes" pre-fills only a fresh container. Next to an existing list the
  // row starts empty — a prefilled default would collide with the usual
  // first graph ("Notes") and paint the screen invalid before any input.
  const icloudName = typedIcloudName ?? (icloudGraphs.length > 0 ? '' : 'Notes')
  const cleanIcloudName = cleanGraphName(icloudName)
  const icloudNameTaken =
    cleanIcloudName !== null && isGraphNameTaken(cleanIcloudName, icloudGraphs)

  function runChoice(choice: Exclude<PendingChoice, null>, task: () => Promise<void>): void {
    setPendingChoice(choice)
    void action.run(task).finally(() => setPendingChoice(null))
  }

  function openIcloudGraph(root: string): void {
    runChoice(root, () => completeOnboarding('icloud', root))
  }

  function createIcloudGraph(): void {
    if (icloudDocumentsRoot === null || cleanIcloudName === null || icloudNameTaken) {
      return
    }
    runChoice('icloud-create', () =>
      completeOnboarding('icloud', graphRootForName(icloudDocumentsRoot, cleanIcloudName)),
    )
  }

  function keepOnDevice(): void {
    runChoice('local', () => completeOnboarding('local'))
  }

  function downloadAndOpen(): void {
    if (action.pending) {
      return // Enter in the repo field must not overlap a running clone.
    }
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
    runChoice('clone', async () => {
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
      className="flex min-h-dvh w-screen overflow-auto bg-surface-app px-5 text-text"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 1.5rem)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)',
      }}
    >
      <div className="my-auto flex w-full flex-col gap-6">
        <div className="flex flex-col gap-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Welcome to Reflect</h1>
          <p className="text-sm text-text-muted">
            {step === 'choose'
              ? 'Your notes are plain markdown files. Choose where to keep them.'
              : 'Sign in to GitHub, then choose the repository to download.'}
          </p>
        </div>

        {step === 'choose' ? (
          <div className="flex flex-col gap-3">
            {icloudReady ? (
              <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Cloud aria-hidden className="size-4" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold">iCloud Drive</h2>
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                        Recommended
                      </span>
                    </div>
                    <p className="text-xs text-text-muted">
                      {icloudGraphs.length > 0
                        ? 'Open an existing set of notes, or create another.'
                        : 'Syncs with Reflect on your other devices.'}
                    </p>
                  </div>
                </div>

                {icloudGraphs.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {icloudGraphs.map((root) => (
                      <li key={root}>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full justify-start"
                          onClick={() => openIcloudGraph(root)}
                          disabled={action.pending}
                        >
                          {pendingChoice === root ? (
                            <Spinner />
                          ) : (
                            <FolderOpen aria-hidden strokeWidth={1.75} />
                          )}
                          <span className="truncate">{graphNameFromRoot(root, root)}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  <label htmlFor={icloudNameId} className="text-xs font-medium text-text-secondary">
                    Name
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id={icloudNameId}
                      value={icloudName}
                      placeholder={icloudGraphs.length > 0 ? 'New name' : undefined}
                      enterKeyHint="go"
                      onChange={(event) => setTypedIcloudName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          createIcloudGraph()
                        }
                      }}
                      aria-invalid={icloudNameTaken}
                      disabled={action.pending}
                    />
                    <Button
                      type="button"
                      className="shrink-0"
                      onClick={createIcloudGraph}
                      disabled={action.pending || cleanIcloudName === null || icloudNameTaken}
                    >
                      {pendingChoice === 'icloud-create' ? (
                        <Spinner />
                      ) : (
                        <Plus aria-hidden strokeWidth={1.75} />
                      )}
                      {pendingChoice === 'icloud-create' ? 'Setting up…' : 'Create'}
                    </Button>
                  </div>
                </div>
                {icloudNameTaken ? (
                  <p className="text-xs text-destructive">
                    That name already exists in iCloud Drive.
                  </p>
                ) : null}
              </section>
            ) : null}

            <Button
              variant={icloudReady ? 'outline' : 'default'}
              onClick={keepOnDevice}
              disabled={action.pending}
            >
              {pendingChoice === 'local' ? (
                <Spinner />
              ) : (
                <HardDrive aria-hidden strokeWidth={1.75} />
              )}
              {pendingChoice === 'local' ? 'Setting up…' : 'Keep notes on this device'}
            </Button>
            {!icloudReady ? (
              <p className="text-center text-xs text-text-muted">
                Sign in to iCloud on this device to sync notes with iCloud Drive.
              </p>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep('auth')}
              disabled={action.pending}
            >
              <GitBranch aria-hidden strokeWidth={1.75} />
              Sync with GitHub instead
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
                disabled={action.pending}
                onChange={(event) => setRepoInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    downloadAndOpen()
                  }
                }}
                placeholder={user !== null ? `${user.login}/…` : 'owner/name'}
                enterKeyHint="go"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <Button onClick={downloadAndOpen} disabled={action.pending}>
              {pendingChoice === 'clone' ? (
                <Spinner />
              ) : (
                <GitBranch aria-hidden strokeWidth={1.75} />
              )}
              {pendingChoice === 'clone' ? 'Downloading…' : 'Download & open'}
            </Button>
            <LinkButton onClick={() => setStep('choose')} disabled={action.pending}>
              Back
            </LinkButton>
          </div>
        )}

        {action.error !== null ? <InlineAlert tone="error">{action.error}</InlineAlert> : null}
      </div>
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
