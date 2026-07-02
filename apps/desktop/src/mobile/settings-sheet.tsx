import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import { errorMessage, hasBridge, listNotes } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { useAppVersion } from '@/hooks/use-app-version'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useMobileSyncStatus } from '@/mobile/use-sync-status'
import { useGraph } from '@/providers/graph-provider'
import { useSyncContext } from '@/providers/sync-provider'

/**
 * The mobile settings sheet (Plan 19, V1 parity) — the trigger lives in V1's
 * avatar spot (top-left of the Daily header). A deliberately small surface:
 * the graph's name, its note count, and the app version, plus the GitHub
 * connection when one exists — its repo, the live plain-language backup
 * status (the same engine state the pill shows), and a Disconnect. Initial
 * connecting happens in onboarding.
 */
export function SettingsSheet(): ReactElement {
  const { graph } = useGraph()
  const version = useAppVersion()
  const sync = useSyncContext()
  const [open, setOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const { data: notes } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'mobile-note-count'],
    queryFn: () => listNotes(),
    enabled: open && hasBridge() && graph !== null,
  })

  const backup = sync?.backup ?? null
  const connected = backup !== null && backup.phase === 'connected'
  // Shared with the status pill (one hook, one query cache entry) — and null
  // until the conflict count is known, so the row never claims `Backed up`
  // over conflict markers already on disk and then flips.
  const status = useMobileSyncStatus()
  const repo = connected ? backup.repo : null

  // Stop backing this graph up and forget the GitHub credential (one graph
  // per device — unlinking is signing out). The local clone stays; the
  // controller restarts into its disconnected state, and re-connecting
  // re-onboards.
  async function disconnect(): Promise<void> {
    if (sync === null) {
      return
    }
    setDisconnecting(true)
    try {
      await sync.disconnectGraph()
      await sync.signOut()
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
          {status !== null ? (
            <div className="py-2.5">
              <div className="flex items-center justify-between">
                <dt className="text-text-muted">Backup</dt>
                <dd className="font-medium">{status.label}</dd>
              </div>
              {status.detail !== null ? (
                <p className="mt-1 text-xs text-text-muted">{status.detail}</p>
              ) : null}
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
