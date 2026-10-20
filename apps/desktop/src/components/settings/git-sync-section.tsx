import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { gitSyncWording, remoteLabel } from '@reflect/app'
import { githubRepoOf, isICloudRoot, suggestRepoName, type GithubRepoRef } from '@reflect/core'
import { CountdownText } from '@/components/countdown-text.tsx'
import { ConnectGithubDialog } from '@/components/settings/connect-github-dialog.tsx'
import { ConnectHostDialog } from '@/components/settings/connect-host-dialog.tsx'
import { SettingsField } from '@/components/settings/field.tsx'
import { SyncForkNotice } from '@/components/settings/sync-fork-notice.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { createDuplicateNoteIdsQueryOptions } from '@/lib/query-options.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useGitSync, type GitSyncState } from '@/providers/sync-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

type Connected = Extract<GitSyncState, { phase: 'connected' }>

/** A short, plain-language line for each git sync state, never Git jargon. */
function GitSyncStatusLine({ state }: { state: Connected }): ReactNode {
  const wording = gitSyncWording(state.coexisting)
  switch (state.status.state) {
    case 'idle':
      return wording.idle
    case 'waiting':
      return (
        <>
          {wording.waiting} <CountdownText until={state.status.until} />
        </>
      )
    case 'syncing':
      return wording.syncing
    case 'offline':
      return state.status.message
    case 'error':
      // The GitHub account row below is the fix for a GitHub remote. A host
      // remote gets "Update sign-in…" beside this line; an SSH remote's
      // message already names the fix (ssh-add, known_hosts…).
      return state.status.errorKind === 'auth' && state.remote.kind === 'github'
        ? `${wording.failed}: sign in to GitHub again`
        : `${wording.failed}: ${state.status.message}`
  }
}

function githubRepoBrowserUrl(repo: GithubRepoRef): string {
  return `https://github.com/${repo.owner}/${repo.name}`
}

/**
 * Settings → Sync → Git repository: connect this graph to a repository on
 * GitHub or any other HTTPS host, see the current state in product language,
 * sync on demand, and stop. The wording follows the graph: a folder graph
 * syncs through its repository; an iCloud-hosted one only keeps a history
 * there.
 */
export function GitSyncSettingsField(): ReactElement {
  const { state, disconnectGraph, syncNow } = useGitSync()
  const { graph } = useGraph()
  const { indexQuery } = useCoreServices()
  const { opener } = useAppServices()
  const [connectGithubOpen, setConnectGithubOpen] = useState(false)
  // `null` = closed; a string = open, prefilled with that remote (may be empty).
  const [connectHostUrl, setConnectHostUrl] = useState<string | null>(null)
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

  const hosted = graph !== null && isICloudRoot(graph.root)
  const wording = gitSyncWording(state.phase === 'connected' ? state.coexisting : hosted)
  const repo = state.phase === 'connected' ? githubRepoOf(state.remote) : null

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
      {wording.stop}
    </Button>
  )

  return (
    <>
      <SettingsField
        variant="card"
        legend="Git repository"
        description={
          state.phase === 'connected' || state.phase === 'needsCredential'
            ? wording.description
            : hosted
              ? 'This graph syncs through iCloud Drive. A repository adds a history that updates after five quiet minutes.'
              : 'Sync this graph with your other devices through a repository on GitHub or any git host, and keep its history.'
        }
      >
        <div className="mt-3 flex flex-col gap-2">
          {state.phase === 'loading' ? (
            <p className="text-xs text-text-muted">Checking the repository…</p>
          ) : null}

          {state.phase === 'disconnected' ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setConnectGithubOpen(true)}>
                Connect GitHub…
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConnectHostUrl('')}>
                Another host…
              </Button>
            </div>
          ) : null}

          {state.phase === 'needsCredential' ? (
            <>
              <p className="text-sm text-text">
                <span className="font-medium">{remoteLabel(state.remote, state.remoteUrl)}</span>
                <span className="ml-2 text-xs text-text-muted">Sign-in needed</span>
              </p>
              <p className="text-xs text-text-muted">
                {state.remote.kind === 'github'
                  ? 'Sign in to GitHub below to resume.'
                  : 'Add the username and access token for this host to resume.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {state.remote.kind === 'https' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConnectHostUrl(state.remoteUrl)}
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
              <SyncForkNotice groups={forkGroups} />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.status.state === 'syncing' || action.pending}
                  onClick={() => void action.run(syncNow)}
                >
                  {wording.now}
                </Button>
                {stopButton}
                {repo !== null ? (
                  <Button variant="ghost" size="sm" onClick={openGithubRepo}>
                    <ExternalLink aria-hidden />
                    Open GitHub repo
                  </Button>
                ) : null}
                {state.remote.kind === 'https' &&
                state.status.state === 'error' &&
                state.status.errorKind === 'auth' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConnectHostUrl(state.remoteUrl)}
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
      {connectGithubOpen ? (
        <ConnectGithubDialog
          suggestedRepoName={suggestRepoName(graph?.name)}
          onClose={() => setConnectGithubOpen(false)}
        />
      ) : null}
      {connectHostUrl !== null ? (
        <ConnectHostDialog
          remoteUrl={connectHostUrl.length === 0 ? undefined : connectHostUrl}
          onClose={() => setConnectHostUrl(null)}
        />
      ) : null}
    </>
  )
}
