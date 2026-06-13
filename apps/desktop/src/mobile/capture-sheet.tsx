import { useState, type ReactElement } from 'react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { appendToDaily, createNoteFromCapture } from '@/mobile/capture'
import { useToday } from '@/lib/use-today'
import { useGraph } from '@/providers/graph-provider'
import { useRouter } from '@/routing/router'

interface CaptureSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The quick-capture sheet (Plan 19, step 9): a bottom sheet with one
 * textarea and the two capture paths — append to today's note, or create a
 * note titled by the first line and open it. Sits above the software
 * keyboard via `--keyboard-height`.
 */
export function CaptureSheet({ open, onOpenChange }: CaptureSheetProps): ReactElement {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const today = useToday()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (): void => {
    setText('')
    setError(null)
    onOpenChange(false)
  }

  const run = (action: () => Promise<void>): void => {
    if (graph === null) {
      return
    }
    setBusy(true)
    setError(null)
    void action()
      .then(close)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  const addToToday = (): void =>
    run(async () => {
      if (graph !== null) {
        await appendToDaily(today, text, graph.generation)
      }
    })

  const newNote = (): void =>
    run(async () => {
      if (graph !== null) {
        const path = await createNoteFromCapture(text, graph.generation)
        if (path !== null) {
          navigate({ kind: 'note', path })
        }
      }
    })

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        showCloseButton={false}
        className="inset-x-0 top-auto left-0 max-w-none translate-x-0 translate-y-0 rounded-b-none data-closed:zoom-out-100 data-open:zoom-in-100"
        style={{ bottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))' }}
      >
        <DialogTitle className="sr-only">Quick capture</DialogTitle>
        <Textarea
          autoFocus
          rows={3}
          value={text}
          placeholder="Capture a thought…"
          className="max-h-[40dvh] text-base"
          onChange={(event) => setText(event.target.value)}
        />
        {error !== null && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy || text.trim() === ''} onClick={newNote}>
            New note
          </Button>
          <Button disabled={busy || text.trim() === ''} onClick={addToToday}>
            Add to today
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
