import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import { hasBridge, listNotes } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useAppVersion } from '@/hooks/use-app-version'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/**
 * The mobile settings sheet (Plan 19, V1 parity) — the trigger lives in V1's
 * avatar spot (top-left of the Daily header). A deliberately small surface:
 * the graph's name, its note count, and the app version. GitHub
 * connect/disconnect and sync status arrive with the sync slice; this sheet
 * is where they'll land.
 */
export function SettingsSheet(): ReactElement {
  const { graph } = useGraph()
  const version = useAppVersion()
  const [open, setOpen] = useState(false)

  const { data: notes } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'mobile-note-count'],
    queryFn: () => listNotes(),
    enabled: open && hasBridge() && graph !== null,
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-9" aria-label="Settings">
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="inset-x-0 bottom-0 top-auto left-0 max-w-none translate-x-0 translate-y-0 rounded-b-none data-closed:zoom-out-100 data-open:zoom-in-100"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
      >
        <DialogTitle>Settings</DialogTitle>
        <dl className="divide-y divide-border text-sm">
          <Row label="Graph" value={graph?.name ?? '—'} />
          <Row label="Notes" value={notes === undefined ? '…' : String(notes.length)} />
          <Row label="Version" value={version ?? '…'} />
        </dl>
      </DialogContent>
    </Dialog>
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
