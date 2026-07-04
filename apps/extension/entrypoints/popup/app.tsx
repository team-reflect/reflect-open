import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import { readQueue } from '@/lib/flush'
import type { FlushResult } from '@/lib/messages'
import { saveCapture } from '@/lib/save-capture'
import {
  readIncludePageTextPreference,
  writeIncludePageTextPreference,
} from '@/lib/popup-preferences'
import { tryExtractPageText } from './extract-page-text'
import { useCapturedPage } from './use-captured-page'

/**
 * The capture popup: a snapshot of the page, an optional note, one Save.
 * On success it closes as soon as the native host has accepted the capture.
 * Hold and failure states stay visible because they require the user's
 * attention.
 */

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'held'; result: FlushResult }
  | { phase: 'failed'; message: string }

const RELEASES_URL = 'https://github.com/team-reflect/reflect-open/releases/latest'

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
  const [includePageText, setIncludePageText] = useState(false)
  const includePageTextTouched = useRef(false)
  const [includePageTextPreferenceLoaded, setIncludePageTextPreferenceLoaded] = useState(false)
  const [save, setSave] = useState<SaveState>({ phase: 'idle' })
  const [heldCount, setHeldCount] = useState(0)

  useEffect(() => {
    void readQueue().then((queue) => setHeldCount(queue.length))
  }, [])

  useEffect(() => {
    let cancelled = false
    void readIncludePageTextPreference().then(
      (preference) => {
        if (!cancelled && !includePageTextTouched.current) {
          setIncludePageText(preference)
        }
        if (!cancelled) {
          setIncludePageTextPreferenceLoaded(true)
        }
      },
      (cause) => {
        console.warn('capture page text preference could not be read:', cause)
        if (!cancelled) {
          setIncludePageTextPreferenceLoaded(true)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (
      captured.status !== 'ready' ||
      !includePageTextPreferenceLoaded ||
      save.phase === 'saving'
    ) {
      return
    }
    setSave({ phase: 'saving' })
    try {
      const contentText = includePageText
        ? await tryExtractPageText(captured.tabId, captured.page.url)
        : undefined
      const outcome = await saveCapture(
        {
          ...captured.page,
          contentText,
          note,
          id: crypto.randomUUID(),
          capturedAt: new Date(),
        },
        () => browser.runtime.sendMessage({ type: 'flush' }),
      )
      if (outcome.fate === 'queued') {
        window.close()
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
  const busy = save.phase === 'saving' || !includePageTextPreferenceLoaded

  function onIncludePageTextChange(checked: boolean): void {
    includePageTextTouched.current = true
    setIncludePageTextPreferenceLoaded(true)
    setIncludePageText(checked)
    void writeIncludePageTextPreference(checked).catch((cause) => {
      console.warn('capture page text preference could not be saved:', cause)
    })
  }

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
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={includePageText}
          onChange={(event) => onIncludePageTextChange(event.target.checked)}
          disabled={busy}
          className="size-3.5 rounded border-border text-accent focus:ring-focus-ring"
        />
        Capture page text
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-text-on-brand hover:bg-accent-hover disabled:opacity-60"
      >
        {save.phase === 'saving' ? 'Saving…' : 'Save to Reflect'}
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
