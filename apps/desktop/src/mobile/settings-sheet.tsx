import { useId, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Settings } from 'lucide-react'
import {
  errorMessage,
  hasBridge,
  listNotes,
  mobileStorage,
  type MobileStorageKind,
} from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { useAppVersion } from '@/hooks/use-app-version'
import {
  cleanGraphName,
  graphNameFromRoot,
  graphRootForName,
  isGraphNameTaken,
} from '@/lib/graph-names'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useMobileSyncStatus } from '@/mobile/use-sync-status'
import { useGraph } from '@/providers/graph-provider'
import { useSyncContext } from '@/providers/sync-provider'

/** A graph the sheet can switch to (anything but the one that's open). */
interface SwitchTarget {
  kind: MobileStorageKind
  root: string
  label: string
}

/**
 * The mobile settings sheet (Plan 19, V1 parity) — the trigger lives in V1's
 * avatar spot (top-left of the Daily header). A deliberately small surface:
 * the graph's name, its note count, and the app version, plus the GitHub
 * connection when one exists — its repo, the live plain-language backup
 * status (the same engine state the pill shows), and a Disconnect. Initial
 * connecting happens in onboarding. **Switch graph** lists every other graph
 * this device can open — the container can hold several, plus the on-device
 * root — and can create another iCloud graph through the same
 * open-and-persist flow; storage roots are re-derived when the sheet opens
 * (container paths must never be cached).
 */
export function SettingsSheet(): ReactElement {
  const { graph, mobileStorageKind, completeOnboarding } = useGraph()
  const version = useAppVersion()
  const sync = useSyncContext()
  const [open, setOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [newGraphName, setNewGraphName] = useState('Notes')
  const newGraphNameId = useId()

  const { data: notes } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'mobile-note-count'],
    queryFn: () => listNotes(),
    enabled: open && hasBridge() && graph !== null,
  })

  const { data: storage } = useQuery({
    queryKey: ['mobile-storage'],
    queryFn: mobileStorage,
    enabled: open && hasBridge(),
  })

  const targets: SwitchTarget[] = []
  if (storage !== undefined && graph !== null) {
    for (const root of storage.icloudGraphRoots) {
      if (root !== graph.root) {
        targets.push({
          kind: 'icloud',
          root,
          label: graphNameFromRoot(root, root),
        })
      }
    }
    if (mobileStorageKind === 'icloud') {
      targets.push({ kind: 'local', root: storage.localRoot, label: 'This device' })
    }
  }
  const icloudDocumentsRoot = storage?.icloudDocumentsRoot ?? null
  const icloudGraphRoots = storage?.icloudGraphRoots ?? []
  const cleanNewGraphName = cleanGraphName(newGraphName)
  const newGraphNameTaken =
    cleanNewGraphName !== null && isGraphNameTaken(cleanNewGraphName, icloudGraphRoots)
  const canCreateIcloudGraph =
    icloudDocumentsRoot !== null && cleanNewGraphName !== null && !newGraphNameTaken
  const showGraphSwitcher = targets.length > 0 || icloudDocumentsRoot !== null

  function switchTo(target: SwitchTarget): void {
    setSwitching(true)
    setSwitchError(null)
    void completeOnboarding(target.kind, target.root).then(
      () => {
        setSwitching(false)
        setOpen(false)
      },
      (err: unknown) => {
        setSwitching(false)
        setSwitchError(errorMessage(err))
      },
    )
  }

  function createIcloudGraph(): void {
    if (icloudDocumentsRoot === null || !canCreateIcloudGraph || cleanNewGraphName === null) {
      return
    }
    switchTo({
      kind: 'icloud',
      root: graphRootForName(icloudDocumentsRoot, cleanNewGraphName),
      label: cleanNewGraphName,
    })
  }

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
          {mobileStorageKind !== null ? (
            <Row
              label="Storage"
              value={mobileStorageKind === 'icloud' ? 'iCloud Drive' : 'This device'}
            />
          ) : null}
          {showGraphSwitcher ? (
            <div className="py-2.5">
              <dt className="text-text-muted">Switch graph</dt>
              <dd className="mt-2 flex flex-col gap-1.5">
                {targets.map((target) => (
                  <Button
                    key={target.root}
                    variant="outline"
                    size="sm"
                    disabled={switching}
                    onClick={() => switchTo(target)}
                  >
                    {switching ? 'Switching…' : target.label}
                  </Button>
                ))}
                {icloudDocumentsRoot !== null ? (
                  <div className="flex flex-col gap-1.5 pt-1">
                    <label
                      htmlFor={newGraphNameId}
                      className="text-xs font-medium text-text-secondary"
                    >
                      New iCloud graph
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id={newGraphNameId}
                        value={newGraphName}
                        onChange={(event) => setNewGraphName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            createIcloudGraph()
                          }
                        }}
                        aria-invalid={newGraphNameTaken}
                        disabled={switching}
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="shrink-0"
                        disabled={switching || !canCreateIcloudGraph}
                        onClick={createIcloudGraph}
                      >
                        <Plus aria-hidden strokeWidth={1.75} />
                        {switching ? 'Creating…' : 'Create'}
                      </Button>
                    </div>
                    {newGraphNameTaken ? (
                      <span className="text-xs text-destructive">
                        That name already exists in iCloud Drive.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </dd>
              {switchError !== null ? (
                <InlineAlert tone="error">{switchError}</InlineAlert>
              ) : null}
            </div>
          ) : null}
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
