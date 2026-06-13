import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import { buildWireMessage } from '@/lib/capture-message'
import { enqueueCapture, readQueue } from '@/lib/flush'
import { flushResultSchema, type FlushResult } from '@/lib/messages'
import { useCapturedPage } from './use-captured-page'

/**
 * The capture popup: a snapshot of the page, an optional note, one Save.
 * Status is honest — the extension can only ever claim **queued** (spooled
 * for Reflect, or held for retry), never "saved": it cannot observe the
 * desktop app draining the inbox.
 */

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'queued' }
  | { phase: 'held'; result: FlushResult }
  | { phase: 'failed'; message: string }

const RELEASES_URL = 'https://github.com/team-reflect/reflect-open/releases/latest'
const CLOSE_DELAY_MS = 900

type SaveOutcome =
  | { fate: 'queued' }
  | { fate: 'held'; result: FlushResult }
  | { fate: 'rejected' }

/**
 * Persist the capture, flush, and report **this capture's** fate — aggregate
 * flush counts can't distinguish an older queued entry's failure from the
 * current save's, so the verdict comes from this id's rejection or its
 * continued presence in the queue.
 */
async function saveCapture(page: Parameters<typeof buildWireMessage>[0]): Promise<SaveOutcome> {
  const wire = buildWireMessage(page)
  await enqueueCapture(wire)
  const response: unknown = await browser.runtime.sendMessage({ type: 'flush' })
  const result = flushResultSchema.parse(response)
  if (result.rejectedIds.includes(wire.envelope.id)) {
    return { fate: 'rejected' }
  }
  const queue = await readQueue()
  const stillHeld = queue.some((entry) => entry.wire.envelope.id === wire.envelope.id)
  return stillHeld ? { fate: 'held', result } : { fate: 'queued' }
}

function holdMessage(result: FlushResult): string {
  switch (result.holdReason) {
    case 'no-host':
      return 'Install Reflect to finish saving — the capture is kept and retries automatically.'
    case 'no-graph':
      return 'Open Reflect and pick a graph first — the capture is kept and retries automatically.'
    default:
      return 'Reflect could not be reached — the capture is kept and retries automatically.'
  }
}

export function CapturePopup(): ReactElement {
  const captured = useCapturedPage()
  const [note, setNote] = useState('')
  const [save, setSave] = useState<SaveState>({ phase: 'idle' })
  const [heldCount, setHeldCount] = useState(0)

  useEffect(() => {
    void readQueue().then((queue) => setHeldCount(queue.length))
  }, [])

  useEffect(() => {
    if (save.phase !== 'queued') {
      return
    }
    const timer = window.setTimeout(() => window.close(), CLOSE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [save.phase])

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (captured.status !== 'ready' || save.phase === 'saving' || save.phase === 'queued') {
      return
    }
    setSave({ phase: 'saving' })
    try {
      const outcome = await saveCapture({
        ...captured.page,
        note,
        id: crypto.randomUUID(),
        capturedAt: new Date(),
      })
      if (outcome.fate === 'queued') {
        setSave({ phase: 'queued' })
      } else if (outcome.fate === 'held') {
        setSave({ phase: 'held', result: outcome.result })
        setHeldCount(outcome.result.held)
      } else {
        setSave({ phase: 'failed', message: 'The capture was rejected — please report this.' })
      }
    } catch (cause) {
      setSave({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  if (captured.status === 'loading') {
    return <div className="h-24" />
  }
  if (captured.status === 'uncapturable') {
    return <p className="p-4 text-sm text-text-muted">This page can’t be captured.</p>
  }

  const { page } = captured
  const host = new URL(page.url).host
  const busy = save.phase === 'saving' || save.phase === 'queued'

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 p-3">
      {page.screenshotDataUrl ? (
        <img
          src={page.screenshotDataUrl}
          alt=""
          className="h-32 w-full rounded-md border border-border object-cover object-top"
        />
      ) : null}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text">{page.title || host}</p>
        <p className="truncate text-xs text-text-muted">{host}</p>
      </div>
      {page.selection ? (
        <blockquote className="max-h-16 overflow-hidden border-l-2 border-border pl-2 text-xs text-text-secondary">
          {page.selection}
        </blockquote>
      ) : null}
      <input
        type="text"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Add a note (optional)"
        autoFocus
        disabled={busy}
        className="rounded-md border border-border bg-input-bg px-2 py-1.5 text-sm text-text outline-none placeholder:text-text-muted focus:ring-2 focus:ring-focus-ring"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-text-on-brand hover:bg-accent-hover disabled:opacity-60"
      >
        {save.phase === 'queued' ? 'Queued' : save.phase === 'saving' ? 'Saving…' : 'Save to Reflect'}
      </button>
      {save.phase === 'held' ? (
        <p className="text-xs text-text-muted">
          {holdMessage(save.result)}{' '}
          {save.result.holdReason === 'no-host' ? (
            <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="text-accent underline">
              Download Reflect
            </a>
          ) : null}
        </p>
      ) : null}
      {save.phase === 'failed' ? (
        <p className="text-xs text-destructive">{save.message}</p>
      ) : null}
      {save.phase === 'idle' && heldCount > 0 ? (
        <p className="text-xs text-text-muted">
          {heldCount} earlier {heldCount === 1 ? 'capture' : 'captures'} waiting for Reflect.
        </p>
      ) : null}
    </form>
  )
}
