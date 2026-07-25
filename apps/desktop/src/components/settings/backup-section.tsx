import { useRef, useState, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useQuery } from '@tanstack/react-query'
import { getConflictedNotes, getDuplicateNoteIds, hasBridge } from '@reflect/core'
import { ExternalLink } from 'lucide-react'
import { ConnectGithubDialog } from '@/components/settings/connect-github-dialog'
import { ConflictedNoteLinks } from '@/components/settings/conflicted-note-links'
import { SettingsField } from '@/components/settings/field'
import { GithubSignOutRow } from '@/components/settings/github-sign-out-row'
import { SyncForkNotice } from '@/components/settings/sync-fork-notice'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/hooks/use-async-action'
import { useGithubConnected } from '@/hooks/use-github-connected'
import { suggestRepoName } from '@/lib/github-repos'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useSync, type BackupState } from '@/providers/sync-provider'

/** A short, plain-language line for each backup state — never Git jargon. */
function statusLine(backup: Extract<BackupState, { phase: 'connected' }>): string {
  switch (backup.status.state) {
    case 'idle':
      return 'Backed up'
    case 'syncing':
      return 'Backing up…'
    case 'offline':
      return backup.status.message
    case 'error':
      // "Reconnect GitHub" only helps when GitHub is the remote; a generic
      // remote's auth message already names the fix (ssh-add, known_hosts…).
      return backup.status.errorKind === 'auth' && backup.repo !== null
        ? 'Backup failed — reconnect GitHub'
        : `Backup failed: ${backup.status.message}`
  }
}

function githubRepoBrowserUrl(repo: NonNullable<Extract<BackupState, { phase: 'connected' }>['repo']>): string {
  return `https://github.com/${repo.owner}/${repo.name}`
}

/**
 * Settings → Sync → GitHub sync: connect a GitHub repository, see the current
 * backup state in product language, back up on demand, and disconnect.
 * Conflicted notes ("needs review") surface here with a count; each conflicted
 * note also shows its own banner when opened.
 */
export function BackupSettingsField(): ReactElement {
  const { backup, disconnectGraph, signOut, backUpNow } = useSync()
  const { graph } = useGraph()
  const githubConnected = useGithubConnected()
  const [connectOpen, setConnectOpen] = useState(false)
  const openRepoAttempt = useRef(0)
  const action = useAsyncAction()

  const conflicted = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, 'conflicted-notes', graph?.root],
    queryFn: () => getConflictedNotes(),
    enabled: hasBridge() && graph !== null,
  })
  const conflictedNotes = conflicted.data ?? []
  const conflictCount = conflictedNotes.length

  // A sync fork (Plan 17): two files claiming one frontmatter id — the same
  // note retitled differently on two devices. Surfaced for review beside the
  // marker conflicts; repair is the user's call, never automatic.
  const duplicateIds = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, 'duplicate-note-ids', graph?.root],
    queryFn: () => getDuplicateNoteIds(),
    enabled: hasBridge() && graph !== null,
  })
  const forkGroups = duplicateIds.data ?? []

  const repoLabel =
    backup.phase === 'connected'
      ? (backup.repo !== null ? `${backup.repo.owner}/${backup.repo.name}` : backup.remoteUrl)
      : null
  // A hand-wired non-GitHub remote (Plan 16) renders the section host-neutral.
  const genericRemote = backup.phase === 'connected' && backup.repo === null

  function openGithubRepo(): void {
    if (backup.phase !== 'connected' || backup.repo === null) {
      return
    }
    const url = githubRepoBrowserUrl(backup.repo)
    const attempt = openRepoAttempt.current + 1
    openRepoAttempt.current = attempt
    action.setError(null)
    void openUrl(url)
      .then(() => {
        if (openRepoAttempt.current === attempt) {
          action.setError(null)
        }
      })
      .catch(() => {
        if (openRepoAttempt.current === attempt) {
          action.setError(`Couldn’t open the browser — visit ${url} yourself.`)
        }
      })
  }

  return (
    <>
      <SettingsField
        legend={genericRemote ? 'Backup' : 'GitHub sync'}
        description={
          genericRemote
            ? 'This graph backs up to its own git remote. Edits back up automatically a few moments after you stop typing.'
            : 'Back up this graph to a GitHub repository. Edits back up automatically a few moments after you stop typing.'
        }
      >
        <div className="mt-3 flex flex-col gap-2">
          {backup.phase === 'loading' ? (
            <p className="text-xs text-text-muted">Checking backup status…</p>
          ) : null}

          {backup.phase === 'disconnected' ? (
            <>
              <div>
                <Button size="sm" onClick={() => setConnectOpen(true)}>
                  Connect GitHub…
                </Button>
              </div>
              {githubConnected ? (
                <GithubSignOutRow
                  signOut={signOut}
                  description="Signed in to GitHub. Sign out to connect a different account."
                />
              ) : null}
            </>
          ) : null}

          {backup.phase === 'connected' ? (
            <>
              <p className="text-sm text-text">
                <span className="font-medium">{repoLabel}</span>
                <span className="ml-2 text-xs text-text-muted">{statusLine(backup)}</span>
              </p>
              {conflictCount > 0 ? (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  <p>
                    {conflictCount === 1
                      ? '1 note needs review'
                      : `${conflictCount} notes need review`}{' '}
                    — open {conflictCount === 1 ? 'it' : 'one'} to keep the version you want:
                  </p>
                  <ConflictedNoteLinks notes={conflictedNotes} />
                </div>
              ) : null}
              <SyncForkNotice groups={forkGroups} />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={backup.status.state === 'syncing' || action.pending}
                  onClick={() => void action.run(backUpNow)}
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
                {backup.repo !== null ? (
                  <Button variant="ghost" size="sm" onClick={openGithubRepo}>
                    <ExternalLink aria-hidden />
                    Open GitHub repo
                  </Button>
                ) : null}
              </div>
              {backup.repo !== null ? (
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
