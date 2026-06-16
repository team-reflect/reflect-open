import { useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import {
  clearGithubAuth,
  errorMessage,
  gitDisconnect,
  gitStatus,
  hasBridge,
  listNotes,
  parseGithubRemote,
} from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { useAppVersion } from '@/hooks/use-app-version'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/**
 * The mobile settings sheet (Plan 19, V1 parity) — the trigger lives in V1's
 * avatar spot (top-left of the Daily header). A deliberately small surface:
 * the graph's name, its note count, and the app version, plus the GitHub
 * connection when one exists (its repo and a Disconnect). Initial connecting
 * happens in onboarding; the live sync status pill arrives with the sync slice.
 */
export function SettingsSheet(): ReactElement {
  const { graph } = useGraph()
  const version = useAppVersion()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const generation = graph?.generation ?? null

  const { data: notes } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'mobile-note-count'],
    queryFn: () => listNotes(),
    enabled: open && hasBridge() && graph !== null,
  })

  const gitStatusKey = [INDEX_QUERY_SCOPE, graph?.root, 'mobile-git-status']
  const { data: git } = useQuery({
    queryKey: gitStatusKey,
    queryFn: () => {
      if (generation === null) {
        throw new Error('git status query ran without a graph generation')
      }
      return gitStatus(generation)
    },
    enabled: open && hasBridge() && generation !== null,
  })

  const repo = git?.remoteUrl != null ? parseGithubRemote(git.remoteUrl) : null

  // Drop the remote and forget the GitHub token. The local clone (notes,
  // history) stays — the graph is simply unlinked; re-connecting re-onboards.
  async function disconnect(): Promise<void> {
    if (generation === null) {
      return
    }
    setDisconnecting(true)
    try {
      await gitDisconnect(generation)
      await clearGithubAuth()
      await queryClient.invalidateQueries({ queryKey: gitStatusKey })
    } catch (err) {
      console.error('GitHub disconnect failed:', errorMessage(err))
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="ghost" size="icon" className="size-9" aria-label="Settings">
          <Settings />
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerTitle>Settings</DrawerTitle>
        <dl className="divide-y divide-border text-sm">
          <Row label="Graph" value={graph?.name ?? '—'} />
          <Row label="Notes" value={notes === undefined ? '…' : String(notes.length)} />
          {repo !== null ? (
            <div className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <dt className="text-text-muted">GitHub</dt>
                <dd className="truncate font-medium">
                  {repo.owner}/{repo.name}
                </dd>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={disconnecting}
                onClick={() => void disconnect()}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          ) : null}
          <Row label="Version" value={version ?? '…'} />
        </dl>
      </DrawerContent>
    </Drawer>
  )
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
