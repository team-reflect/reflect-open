import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { remoteLabel, signInNeededText } from '@reflect/app'
import { githubRepoOf, isICloudRoot, suggestRepoName, type GithubRepoRef } from '@reflect/core'
import { CountdownText } from '@/components/countdown-text.tsx'
import { ConnectGithubDialog } from '@/components/settings/connect-github-dialog.tsx'
import { ConnectGitHostDialog } from '@/components/settings/connect-git-host-dialog.tsx'
import { ConnectRepositoryDialog } from '@/components/settings/connect-repository-dialog.tsx'
import { SettingsField } from '@/components/settings/field.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useGitSync, type GitSyncState } from '@/providers/sync-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/** Which dialog is open: the host chooser, or one host's own flow. */
type OpenDialog =
  | { kind: 'choose' }
  | { kind: 'github' }
  // `remoteUrl` prefills the form for a remote that is already set.
  | { kind: 'host'; remoteUrl?: string }

/** A short, plain-language line for each git sync state, never Git jargon. */
function GitSyncStatusLine({
  state,
}: {
  state: Extract<GitSyncState, { phase: 'connected' }>
}): ReactNode {
  switch (state.status.state) {
    case 'idle':
      return 'Up to date'
    case 'waiting':
      return (
        <>
          Syncs in <CountdownText until={state.status.until} />
        </>
      )
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return state.status.message
    case 'error':
      // A rejected GitHub sign-in (expired or revoked; the account is still
      // stored) is fixed under Accounts. A host remote gets "Update sign-in…"
      // beside this line; an SSH remote's message already names the fix
      // (ssh-add, known_hosts…).
      return state.status.errorKind === 'auth' && state.remote.kind === 'github'
        ? 'Sync failed: GitHub rejected the sign-in. Sign in again under Accounts.'
        : `Sync failed: ${state.status.message}`
  }
}

function githubRepoBrowserUrl(repo: GithubRepoRef): string {
  return `https://github.com/${repo.owner}/${repo.name}`
}

/**
 * Settings → Sync → Git repository: connect this graph to a repository on
 * GitHub or any other https host through one door, see the current state in
 * product language, sync on demand, and stop.
 */
export function GitSyncSettingsField(): ReactElement {
  const { state, disconnectGraph, syncNow } = useGitSync()
  const { graph } = useGraph()
  const { opener } = useAppServices()
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const openRepoAttemptRef = useRef(0)
  const action = useAsyncAction()

  const hosted = graph !== null && isICloudRoot(graph.root)
  const repo = state.phase === 'connected' ? githubRepoOf(state.remote) : null
  // A remote that waits for its sign-in: a host sign-in is added here, a
  // GitHub one under Accounts, and plain http never gets one.
  const canAddSignIn =
    state.phase === 'needsCredential' &&
    state.remote.kind === 'https' &&
    !state.remote.origin.startsWith('http:')

  function openGithubRepo(): void {
    if (repo === null) {
      return
    }
    const url = githubRepoBrowserUrl(repo)
    const attempt = openRepoAttemptRef.current + 1
    openRepoAttemptRef.current = attempt
    action.setError(null)
    void opener
      .openUrl(url)
      .then(() => {
        if (openRepoAttemptRef.current === attempt) {
          action.setError(null)
        }
      })
      .catch(() => {
        if (openRepoAttemptRef.current === attempt) {
          action.setError(`Couldn’t open the browser — visit ${url} yourself.`)
        }
      })
  }

  const stopButton = (
    <Button
      variant="ghost"
      size="sm"
      title="This graph stops syncing; its history and your sign-ins stay"
      onClick={() => void action.run(disconnectGraph)}
    >
      Stop syncing
    </Button>
  )

  return (
    <>
      <SettingsField
        legend="Git repository"
        description={
          state.phase === 'connected' && !state.isPrimaryChannel
            ? 'Syncs this graph’s history to the repository five minutes after iCloud and your edits go quiet.'
            : state.phase === 'connected'
              ? 'Syncs this graph with your other devices and keeps its history.'
              : hosted
                ? 'This graph syncs through iCloud Drive. A repository adds a history that updates after five quiet minutes.'
                : 'Sync this graph with your other devices through a Git repository, and keep its history.'
        }
      >
        <div className="mt-3 flex flex-col gap-2">
          {state.phase === 'loading' ? (
            <p className="text-xs text-text-muted">Checking the repository…</p>
          ) : null}

          {state.phase === 'disconnected' ? (
            <div>
              <Button size="sm" onClick={() => setDialog({ kind: 'choose' })}>
                Connect a repository…
              </Button>
            </div>
          ) : null}

          {state.phase === 'needsCredential' ? (
            <>
              <p className="text-sm text-text">
                <span className="font-medium">{remoteLabel(state.remote, state.remoteUrl)}</span>
                <span className="ml-2 text-xs text-text-muted">Sign-in needed</span>
              </p>
              <p className="text-xs text-text-muted">{signInNeededText(state.remote)}</p>
              <div className="flex flex-wrap gap-2">
                {canAddSignIn ? (
                  <Button
                    size="sm"
                    onClick={() => setDialog({ kind: 'host', remoteUrl: state.remoteUrl })}
                  >
                    Add sign-in…
                  </Button>
                ) : null}
                {stopButton}
              </div>
            </>
          ) : null}

          {state.phase === 'connected' ? (
            <>
              <p className="text-sm text-text">
                <span className="font-medium">{remoteLabel(state.remote, state.remoteUrl)}</span>
                <span className="ml-2 text-xs text-text-muted">
                  <GitSyncStatusLine state={state} />
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                {/* Beside iCloud the engine only commits now; the repository
                    updates after the quiet window, so the button says so. */}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.status.state === 'syncing' || action.pending}
                  title={
                    state.isPrimaryChannel
                      ? undefined
                      : 'Saves the history now; the repository updates after five quiet minutes'
                  }
                  onClick={() => void action.run(syncNow)}
                >
                  {state.isPrimaryChannel ? 'Sync now' : 'Save history now'}
                </Button>
                {stopButton}
                {repo !== null ? (
                  <Button variant="ghost" size="sm" onClick={openGithubRepo}>
                    <ExternalLink aria-hidden />
                    Open on GitHub
                  </Button>
                ) : null}
                {state.remote.kind === 'https' &&
                state.status.state === 'error' &&
                state.status.errorKind === 'auth' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDialog({ kind: 'host', remoteUrl: state.remoteUrl })}
                  >
                    Update sign-in…
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}

          {action.error !== null ? (
            <p className="text-xs text-red-700 dark:text-red-300">{action.error}</p>
          ) : null}
        </div>
      </SettingsField>
      {dialog?.kind === 'choose' ? (
        <ConnectRepositoryDialog
          onChoose={(host) => setDialog(host === 'github' ? { kind: 'github' } : { kind: 'host' })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'github' ? (
        <ConnectGithubDialog
          suggestedRepoName={suggestRepoName(graph?.name)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'host' ? (
        <ConnectGitHostDialog remoteUrl={dialog.remoteUrl} onClose={() => setDialog(null)} />
      ) : null}
    </>
  )
}
