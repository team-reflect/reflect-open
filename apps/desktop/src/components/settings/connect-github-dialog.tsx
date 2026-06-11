import { useState, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  githubAppInstallUrl,
  isDeviceFlowConfigured,
  newRepoUrl,
  type GithubRepoRef,
  type GithubUser,
} from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { GithubAuthStep } from '@/components/settings/github-auth-step'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAsyncAction } from '@/hooks/use-async-action'
import { useRestoreFocus } from '@/hooks/use-restore-focus'
import { parseRepoInput } from '@/lib/github-repos'
import { useSync } from '@/providers/sync-provider'

interface ConnectGithubDialogProps {
  /** A suggested name for a newly created backup repo (from the graph name). */
  suggestedRepoName: string
  onClose: () => void
}

type Step = 'repo' | 'auth' | 'finish'

const STEP_DESCRIPTIONS: Record<Step, string> = {
  repo: 'Back up this graph to a private GitHub repository of your own.',
  auth: 'Sign in so Reflect can push your backups.',
  finish: 'Connecting your backup repository…',
}

/**
 * The "Connect GitHub" wizard, ordered around how GitHub tokens actually
 * work: **the repository comes first** (creating it needs no credential —
 * the prefilled github.com/new handoff is one click), then the token (whose
 * instructions can now name that exact repository, and which a fine-grained
 * token can be scoped to because it exists), then the connection — built
 * from the verified sign-in (`owner` is never asked for).
 *
 * Tokens that *can* create repositories (classic PATs, app tokens) skip the
 * handoff: the finish step silently API-creates when the repo doesn't exist
 * yet and the user never clicked "Create on GitHub". Connecting a public
 * repo demands explicit confirmation — every note in the graph, including
 * `private: true` ones, would be world-readable.
 */
export function ConnectGithubDialog({
  suggestedRepoName,
  onClose,
}: ConnectGithubDialogProps): ReactElement {
  const { connectNewRepo, connectExistingRepo } = useSync()
  const action = useAsyncAction()
  const [step, setStep] = useState<Step>('repo')
  const [mode, setMode] = useState<'create' | 'existing'>('create')
  const [repoName, setRepoName] = useState(suggestedRepoName)
  const [existingRepo, setExistingRepo] = useState('')
  const [user, setUser] = useState<GithubUser | null>(null)
  const [publicConfirm, setPublicConfirm] = useState<GithubRepoRef | null>(null)
  /** The finish step's "repo not found yet" guidance (create-mode only). */
  const [showCreateGuide, setShowCreateGuide] = useState(false)

  useRestoreFocus()

  function targetRef(forUser: GithubUser): GithubRepoRef | null {
    if (mode === 'existing') {
      return parseRepoInput(existingRepo)
    }
    const name = repoName.trim()
    return name.length === 0 ? null : { owner: forUser.login, name }
  }

  async function finish(forUser: GithubUser, allowPublic = false): Promise<void> {
    await action.run(async () => {
      // Each attempt re-derives the guide from its own outcome — a stale
      // "can't create repositories" panel from an earlier path must not
      // outlive the detour (e.g. consent screen → choose another repo).
      setShowCreateGuide(false)
      const ref = publicConfirm ?? targetRef(forUser)
      if (ref === null) {
        action.setError(
          mode === 'existing'
            ? 'Enter the repository as owner/name or a GitHub URL.'
            : 'Name the repository.',
        )
        setStep('repo')
        return
      }
      const result = await connectExistingRepo(ref, { allowPublic })
      if (result === 'connected') {
        onClose()
        return
      }
      if (result === 'needsPublicConfirm') {
        setPublicConfirm(ref)
        return
      }
      // Not found. For an existing repo that's the answer; for a new one,
      // create it — by API when the token can, by guided handoff otherwise.
      if (mode === 'existing') {
        action.setError(
          'That repository was not found (check the name and the token’s repo access).',
        )
        return
      }
      const created = await connectNewRepo(ref.name)
      if (created === 'connected') {
        onClose()
        return
      }
      setShowCreateGuide(true)
    })
  }

  function continueFromRepo(): void {
    action.setError(null)
    if (mode === 'create' && repoName.trim().length === 0) {
      action.setError('Name the repository.')
      return
    }
    if (mode === 'existing' && parseRepoInput(existingRepo) === null) {
      action.setError('Enter the repository as owner/name or a GitHub URL.')
      return
    }
    setStep('auth')
  }

  function onAuthed(authedUser: GithubUser): void {
    setUser(authedUser)
    setStep('finish')
    void finish(authedUser)
  }

  /** Back to the repo step — every finish-step dead end must offer this. */
  function backToRepo(): void {
    action.setError(null)
    setPublicConfirm(null)
    setShowCreateGuide(false)
    setStep('repo')
  }

  /** Open in the browser; an opener failure surfaces the URL to visit by hand. */
  function openExternal(url: string): void {
    void openUrl(url).catch(() => {
      action.setError(`Couldn’t open the browser — visit ${url} yourself.`)
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect GitHub</DialogTitle>
          <DialogDescription>{STEP_DESCRIPTIONS[step]}</DialogDescription>
        </DialogHeader>

        {step === 'repo' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={mode === 'create'}
                  onChange={() => setMode('create')}
                />
                Create a new private repository
              </label>
              {mode === 'create' ? (
                <div className="ml-6 flex flex-col gap-2">
                  <Input
                    autoFocus
                    value={repoName}
                    onChange={(event) => setRepoName(event.target.value)}
                    aria-label="New repository name"
                  />
                  <p className="text-xs text-text-muted">
                    Reflect creates it for you where it can; otherwise one click on GitHub with
                    everything pre-filled — private either way.
                  </p>
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="repo-mode"
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
            <Button onClick={continueFromRepo} size="sm">
              Continue
            </Button>
          </div>
        ) : null}

        {step === 'auth' ? (
          <GithubAuthStep
            onAuthed={onAuthed}
            repoName={mode === 'create' ? repoName.trim() : undefined}
          />
        ) : null}

        {step === 'finish' ? (
          <div className="flex flex-col gap-3">
            {user !== null ? (
              <p className="text-xs text-text-muted">
                Signed in as <strong className="text-text">{user.login}</strong>
              </p>
            ) : null}

            {publicConfirm !== null ? (
              <>
                <InlineAlert tone="error">
                  <strong>
                    {publicConfirm.owner}/{publicConfirm.name} is public.
                  </strong>{' '}
                  Everything in this graph — including notes marked private — would be readable
                  by anyone on the internet.
                </InlineAlert>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={backToRepo}>
                    Choose another repo
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={action.pending || user === null}
                    onClick={() => {
                      if (user !== null) {
                        void finish(user, true)
                      }
                    }}
                  >
                    Back up to a public repo
                  </Button>
                </div>
              </>
            ) : showCreateGuide && user !== null ? (
              <>
                <p className="text-sm text-text">
                  Your token can’t create repositories, but GitHub can — everything is
                  pre-filled, so it’s one click. Create{' '}
                  <strong>
                    {user.login}/{repoName.trim()}
                  </strong>{' '}
                  there, then connect.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => openExternal(newRepoUrl(repoName.trim()))}>
                    Create on GitHub…
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={action.pending}
                    onClick={() => void finish(user)}
                  >
                    I created it — connect
                  </Button>
                </div>
                <p className="text-xs text-text-muted">
                  If connecting still can’t find it, make sure the new repository is included in
                  your token’s repository access.
                </p>
              </>
            ) : (
              <p className="text-sm text-text-muted">
                {action.pending ? 'Connecting…' : 'Almost there.'}
              </p>
            )}

            {!action.pending && action.error !== null ? (
              <>
                <InlineAlert tone="error">{action.error}</InlineAlert>
                {publicConfirm === null ? (
                  // A failed connect must never strand the user here: this is
                  // the way back to change the repository (the consent screen
                  // above has its own "Choose another repo").
                  <Button variant="outline" size="sm" onClick={backToRepo}>
                    Change repository
                  </Button>
                ) : null}
              </>
            ) : null}

            {isDeviceFlowConfigured() && publicConfirm === null ? (
              // Authorization and installation are separate GitHub App
              // concepts: a signed-in token only reaches repositories the
              // app is installed on. When the repo can't be seen, this is
              // usually why.
              <button
                type="button"
                className="text-left text-xs text-text-muted underline"
                onClick={() => openExternal(githubAppInstallUrl())}
              >
                Can’t see your repository? Grant the Reflect app access on GitHub…
              </button>
            ) : null}
          </div>
        ) : null}

        {step !== 'finish' && action.error !== null ? (
          <InlineAlert tone="error">{action.error}</InlineAlert>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
