import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { isICloudRoot, suggestRepoName } from '@reflect/core'
import { CountdownText } from '@/components/countdown-text.tsx'
import { ConnectGithubDialog } from '@/components/settings/connect-github-dialog.tsx'
import { SettingsField } from '@/components/settings/field.tsx'
import { GithubSignOutRow } from '@/components/settings/github-sign-out-row.tsx'
import { SyncForkNotice } from '@/components/settings/sync-fork-notice.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useGithubConnected } from '@/hooks/use-github-connected.ts'
import { createDuplicateNoteIdsQueryOptions } from '@/lib/query-options.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useGitSync, type GitSyncState } from '@/providers/sync-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/** A short, plain-language line for each git sync state, never Git jargon. */
function GitSyncStatusLine({
  state,
}: {
  state: Extract<GitSyncState, { phase: 'connected' }>
}): ReactNode {
  switch (state.status.state) {
    case 'idle':
      return 'Backed up'
    case 'waiting':
      return (
        <>
          Backs up in <CountdownText until={state.status.until} />
        </>
      )
    case 'syncing':
      return 'Backing up…'
    case 'offline':
      return state.status.message
    case 'error':
      // "Reconnect GitHub" only helps when GitHub is the remote; a generic
      // remote's auth message already names the fix (ssh-add, known_hosts…).
      return state.status.errorKind === 'auth' && state.repo !== null
        ? 'Backup failed — reconnect GitHub'
        : `Backup failed: ${state.status.message}`
  }
}

function githubRepoBrowserUrl(
  repo: NonNullable<Extract<GitSyncState, { phase: 'connected' }>['repo']>,
): string {
  return `https://github.com/${repo.owner}/${repo.name}`
}

/**
 * Settings → Sync → GitHub sync: connect a GitHub repository, see the current
 * git sync state in product language, back up on demand, and disconnect.
 */
export function GitSyncSettingsField(): ReactElement {
  const { state, disconnectGraph, signOut, syncNow } = useGitSync()
  const { graph } = useGraph()
  const { indexQuery } = useCoreServices()
  const { opener } = useAppServices()
  const githubConnected = useGithubConnected()
  const [connectOpen, setConnectOpen] = useState(false)
  const openRepoAttemptRef = useRef(0)
  const action = useAsyncAction()

  // A sync fork (Plan 17): two files claiming one frontmatter id — the same
  // note retitled differently on two devices. Surfaced for review;
  // repair is the user's call, never automatic.
  const duplicateIds = useQuery({
    ...createDuplicateNoteIdsQueryOptions(indexQuery, graph?.root),
    enabled: graph !== null,
  })
  const forkGroups = duplicateIds.data ?? []

  const repoLabel =
    state.phase === 'connected'
      ? state.repo !== null
        ? `${state.repo.owner}/${state.repo.name}`
        : state.remoteUrl
      : null
  // A hand-wired non-GitHub remote (Plan 16) renders the section host-neutral.
  const genericRemote = state.phase === 'connected' && state.repo === null
  const hosted = graph !== null && isICloudRoot(graph.root)

  function openGithubRepo(): void {
    if (state.phase !== 'connected' || state.repo === null) {
      return
    }
    const url = githubRepoBrowserUrl(state.repo)
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

  return (
    <>
      <SettingsField
        legend={genericRemote ? 'Backup' : 'GitHub sync'}
        description={
          hosted && state.phase === 'connected'
            ? `${genericRemote ? 'Pushes to the backup' : 'Backs up to GitHub'} five minutes after iCloud and your edits go quiet. Back up now commits locally.`
            : genericRemote
              ? 'This graph backs up to its own git remote. Edits back up automatically a few moments after you stop typing.'
              : 'Back up this graph to a GitHub repository. Edits back up automatically a few moments after you stop typing.'
        }
      >
        <div className="mt-3 flex flex-col gap-2">
          {state.phase === 'loading' ? (
            <p className="text-xs text-text-muted">Checking backup status…</p>
          ) : null}

          {state.phase === 'disconnected' ? (
            <>
              <div>
                <Button size="sm" onClick={() => setConnectOpen(true)}>
                  Connect GitHub…
                </Button>
              </div>
              {hosted ? (
                <p className="text-xs text-text-muted">
                  This graph already syncs through iCloud Drive. One sync method per graph is
                  simplest; a GitHub backup here pushes only after five quiet minutes.
                </p>
              ) : null}
              {githubConnected ? (
                <GithubSignOutRow
                  signOut={signOut}
                  description="Signed in to GitHub. Sign out to connect a different account."
                />
              ) : null}
            </>
          ) : null}

          {state.phase === 'connected' ? (
            <>
              <p className="text-sm text-text">
                <span className="font-medium">{repoLabel}</span>
                <span className="ml-2 text-xs text-text-muted">
                  <GitSyncStatusLine state={state} />
                </span>
              </p>
              <SyncForkNotice groups={forkGroups} />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.status.state === 'syncing' || action.pending}
                  onClick={() => void action.run(syncNow)}
                >
                  Back up now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="This graph stops backing up; its history and your GitHub sign-in stay"
                  onClick={() => void action.run(disconnectGraph)}
                >
                  Stop backing up
                </Button>
                {state.repo !== null ? (
                  <Button variant="ghost" size="sm" onClick={openGithubRepo}>
                    <ExternalLink aria-hidden />
                    Open GitHub repo
                  </Button>
                ) : null}
              </div>
              {state.repo !== null ? (
                <GithubSignOutRow
                  signOut={signOut}
                  description="Sign out on this machine; connected graphs stop backing up."
                />
              ) : null}
            </>
          ) : null}

          {action.error !== null ? (
            <p className="text-xs text-red-700 dark:text-red-300">{action.error}</p>
          ) : null}
        </div>
      </SettingsField>
      {connectOpen ? (
        <ConnectGithubDialog
          suggestedRepoName={suggestRepoName(graph?.name)}
          onClose={() => setConnectOpen(false)}
        />
      ) : null}
    </>
  )
}
