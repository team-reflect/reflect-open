import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getConflictedNotes, hasBridge } from '@reflect/core'
import { ConnectGithubDialog } from '@/components/settings/connect-github-dialog'
import { SettingsField } from '@/components/settings/field'
import { SettingsSection } from '@/components/settings/section'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/hooks/use-async-action'
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
      return backup.status.errorKind === 'auth'
        ? 'Backup failed — reconnect GitHub'
        : `Backup failed: ${backup.status.message}`
  }
}

/**
 * Settings → Backup: connect a GitHub repository, see the current backup
 * state in product language, back up on demand, and disconnect. Conflicted
 * notes ("needs review") surface here with a count; each conflicted note
 * also shows its own banner when opened.
 */
export function BackupSection(): ReactElement {
  const { backup, disconnectGraph, signOut, backUpNow } = useSync()
  const { graph } = useGraph()
  const [connectOpen, setConnectOpen] = useState(false)
  const action = useAsyncAction()

  const conflicted = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, 'conflicted-notes', graph?.root],
    queryFn: () => getConflictedNotes(),
    enabled: hasBridge() && graph !== null,
  })
  const conflictCount = conflicted.data?.length ?? 0

  const repoLabel =
    backup.phase === 'connected'
      ? (backup.repo !== null ? `${backup.repo.owner}/${backup.repo.name}` : backup.remoteUrl)
      : null

  return (
    <SettingsSection id="backup">
      <SettingsField
        legend="GitHub backup"
        description="Back up this graph to a GitHub repository. Edits back up automatically a few moments after you stop typing."
      >
        <div className="mt-3 flex flex-col gap-2">
          {backup.phase === 'loading' ? (
            <p className="text-xs text-text-muted">Checking backup status…</p>
          ) : null}

          {backup.phase === 'disconnected' ? (
            <div>
              <Button size="sm" onClick={() => setConnectOpen(true)}>
                Connect GitHub…
              </Button>
            </div>
          ) : null}

          {backup.phase === 'connected' ? (
            <>
              <p className="text-sm text-text">
                <span className="font-medium">{repoLabel}</span>
                <span className="ml-2 text-xs text-text-muted">{statusLine(backup)}</span>
              </p>
              {conflictCount > 0 ? (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {conflictCount === 1
                    ? '1 note needs review'
                    : `${conflictCount} notes need review`}{' '}
                  — open it to keep the version you want.
                </p>
              ) : null}
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
                <Button
                  variant="ghost"
                  size="sm"
                  title="Removes the GitHub token from this machine — every connected graph stops backing up"
                  onClick={() => void action.run(signOut)}
                >
                  Sign out of GitHub
                </Button>
              </div>
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
    </SettingsSection>
  )
}
