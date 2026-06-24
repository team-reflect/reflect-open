import { useState, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  githubAppInstallUrl,
  loadGithubAuth,
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
import { usePoll } from '@/hooks/use-poll'
import { useRestoreFocus } from '@/hooks/use-restore-focus'
import { parseRepoInput } from '@/lib/github-repos'
import { useSync } from '@/providers/sync-provider'

interface ConnectGithubDialogProps {
  /** A suggested name for a newly created backup repo (from the graph name). */
  suggestedRepoName: string
  onClose: () => void
  /** Delay between repo-existence polls on the create handoff (test hook). */
  pollIntervalMs?: number
}

type Step = 'repo' | 'auth' | 'finish'

/** Which credential the sign-in stored — decides the can't-find-repo remedy. */
type AuthKind = 'app' | 'pat' | null

const STEP_DESCRIPTIONS: Record<Step, string> = {
  repo: 'Back up this graph to a private GitHub repository.',
  auth: 'Sign in so Reflect can push your backups.',
  finish: 'Connecting your repository…',
}

/**
 * The "Connect GitHub" wizard: repository first (creating one needs no
 * credential), then the sign-in (whose instructions can name that exact
 * repository), then the connection — built from the verified sign-in, so
 * the owner is never asked for.
 *
 * Tokens that can create repositories (classic PATs, app tokens) connect in
 * one step: the finish step API-creates silently. Tokens that can't are
 * handed the prefilled github.com/new page while the dialog polls for the
 * repository and connects the moment it exists — there is no "I created it"
 * button to click. Connecting a public repo demands explicit confirmation:
 * every note in the graph, including `private: true` ones, would be
 * world-readable.
 *
 * Granting repository access is a first-class step, not an error. A GitHub App
 * user token only reaches repositories the app is installed on (authorization
 * ≠ installation), and a fresh install is on zero repos — so an app sign-in
 * that can't yet see the repo lands on a plain "grant access" step that polls
 * and connects the moment access is granted (no retry button to press). The
 * step is skipped whenever the repo is already visible, so a graph whose repo
 * the install already covers connects with no detour. The step steers users to
 * grant access to *only the backup repository* — never "All repositories",
 * which would hand the app every repo on the account for no reason. PAT users
 * reach repos by token scope, not an installation, so they get token-scope
 * guidance.
 */
export function ConnectGithubDialog({
  suggestedRepoName,
  onClose,
  pollIntervalMs = 3000,
}: ConnectGithubDialogProps): ReactElement {
  const { connectNewRepo, connectExistingRepo } = useSync()
  const action = useAsyncAction()
  const [step, setStep] = useState<Step>('repo')
  const [mode, setMode] = useState<'create' | 'existing'>('create')
  const [repoName, setRepoName] = useState(suggestedRepoName)
  const [existingRepo, setExistingRepo] = useState('')
  const [user, setUser] = useState<GithubUser | null>(null)
  const [authKind, setAuthKind] = useState<AuthKind>(null)
  const [publicConfirm, setPublicConfirm] = useState<GithubRepoRef | null>(null)
  /** The finish step's "create it on GitHub" handoff (create-mode only). */
  const [showCreateGuide, setShowCreateGuide] = useState(false)
  /**
   * App sign-in can't see the chosen repo yet (the app isn't installed on it).
   * Show the "grant access" step and poll until access lands. Skipped when the
   * repo is already visible — most installs need it, returning ones don't.
   */
  const [showGrantAccess, setShowGrantAccess] = useState(false)

  useRestoreFocus()

  function targetRef(forUser: GithubUser): GithubRepoRef | null {
    if (mode === 'existing') {
      return parseRepoInput(existingRepo)
    }
    const name = repoName.trim()
    return name.length === 0 ? null : { owner: forUser.login, name }
  }

  // The repo we're trying to reach, resolved from the verified sign-in (the
  // owner is never typed). Drives both the poll and the grant-access copy.
  const targetForUser = user !== null ? targetRef(user) : null

  // While the create handoff or the grant-access step is showing, poll for the
  // repository instead of making the user click a button: the connect fires the
  // moment the repo exists and the app can see it. A 404 just keeps waiting; a
  // public repo stops the poll for consent.
  const pollTarget =
    (showCreateGuide || showGrantAccess) && publicConfirm === null ? targetForUser : null
  usePoll(pollTarget !== null, pollIntervalMs, async () => {
    if (pollTarget === null) {
      return 'stop'
    }
    const result = await connectExistingRepo(pollTarget, { allowPublic: false })
    if (result === 'connected') {
      onClose()
      return 'stop'
    }
    if (result === 'needsPublicConfirm') {
      setPublicConfirm(pollTarget)
      return 'stop'
    }
    return 'continue'
  })

  async function finish(
    forUser: GithubUser,
    options: { allowPublic?: boolean; kind?: AuthKind } = {},
  ): Promise<void> {
    // The credential kind is passed in on the first run — its setter fires
    // in the same tick as the call, before the state commits.
    const kind = options.kind ?? authKind
    await action.run(async () => {
      // Each attempt re-derives the guidance from its own outcome — a stale
      // create guide or grant-access step from an earlier path must not outlive
      // the detour (e.g. consent → choose another repo).
      setShowCreateGuide(false)
      setShowGrantAccess(false)
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
      const result = await connectExistingRepo(ref, { allowPublic: options.allowPublic ?? false })
      if (result === 'connected') {
        onClose()
        return
      }
      if (result === 'needsPublicConfirm') {
        setPublicConfirm(ref)
        return
      }
      if (mode === 'existing') {
        // GitHub's 404 can't distinguish "doesn't exist" from "no access". App
        // sign-ins almost always mean the latter — the app isn't installed on
        // the repo yet — so granting access is the expected next step, not an
        // error: show it plainly and let the poll connect the moment access
        // lands. PAT users reach repos by token scope, not an installation, so
        // they get token-scope guidance instead.
        if (kind === 'app') {
          setShowGrantAccess(true)
        } else {
          action.setError(
            'Repository not found. Check the name and your token’s repository access.',
          )
        }
        return
      }
      // A new repo that doesn't exist yet: create it — by API when the token
      // can, by the guided handoff (plus polling) otherwise.
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
    void loadGithubAuth().then((auth) => {
      const kind = auth?.kind ?? null
      setAuthKind(kind)
      return finish(authedUser, { kind })
    })
  }

  /** Back to the repo step — every finish-step dead end must offer this. */
  function backToRepo(): void {
    action.setError(null)
    setPublicConfirm(null)
    setShowCreateGuide(false)
    setShowGrantAccess(false)
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
                  Anyone on the internet can read everything in this graph, including notes
                  marked private.
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
                        void finish(user, { allowPublic: true })
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
                  Create{' '}
                  <strong>
                    {user.login}/{repoName.trim()}
                  </strong>{' '}
                  on GitHub. Reflect will connect it as soon as it exists.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => openExternal(newRepoUrl(repoName.trim()))}>
                    Create on GitHub…
                  </Button>
                  <Button variant="outline" size="sm" onClick={backToRepo}>
                    Change repository
                  </Button>
                </div>
                <p className="text-xs text-text-muted">Waiting for the repository…</p>
                {authKind === 'app' ? (
                  <p className="text-xs text-text-muted">
                    If it doesn’t connect,{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => openExternal(githubAppInstallUrl())}
                    >
                      grant the Reflect app access
                    </button>{' '}
                    to just this repository.
                  </p>
                ) : (
                  <p className="text-xs text-text-muted">
                    If it doesn’t connect, add it to your token’s repository access.
                  </p>
                )}
              </>
            ) : showGrantAccess && targetForUser !== null ? (
              <>
                <p className="text-sm text-text">
                  Give Reflect access to{' '}
                  <strong>
                    {targetForUser.owner}/{targetForUser.name}
                  </strong>{' '}
                  so it can back up here.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => openExternal(githubAppInstallUrl())}>
                    Grant access on GitHub…
                  </Button>
                  <Button variant="outline" size="sm" onClick={backToRepo}>
                    Change repository
                  </Button>
                </div>
                {/* Steer to per-repo selection: the backup needs exactly one
                    repo, so "All repositories" is needless account-wide risk. */}
                <p className="text-xs text-text-muted">
                  On GitHub, choose <strong>Only select repositories</strong> — Reflect only needs
                  this one.
                </p>
                <p className="text-xs text-text-muted">Waiting for access…</p>
              </>
            ) : action.pending ? (
              <p className="text-sm text-text-muted">Connecting…</p>
            ) : null}

            {!action.pending && action.error !== null ? (
              <>
                <InlineAlert tone="error">{action.error}</InlineAlert>
                {publicConfirm === null && !showCreateGuide && !showGrantAccess ? (
                  // A failed connect must never strand the user here — offer the
                  // way back to a different repository. (The create guide and
                  // grant-access step render their own escapes, so both are
                  // excluded.)
                  <Button variant="outline" size="sm" onClick={backToRepo}>
                    Change repository
                  </Button>
                ) : null}
              </>
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
