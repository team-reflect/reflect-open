import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import { readQueue } from '@/lib/flush'
import type { FlushResult } from '@/lib/messages'
import { saveCapture } from '@/lib/save-capture'
import {
  readIncludePageSummaryPreference,
  readIncludePageTextPreference,
  writeIncludePageSummaryPreference,
  writeIncludePageTextPreference,
} from '@/lib/popup-preferences'
import {
  pageSummaryAvailability,
  startPageSummary,
  type PageSummaryAvailability,
  type PageSummaryTask,
} from '@/lib/page-summary'
import { tryExtractPageText } from './extract-page-text'
import { runCaptureFlow, type CaptureFlowPhase } from './capture-flow'
import { useCapturedPage } from './use-captured-page'

/**
 * The capture popup: a snapshot of the page, an optional note, one Save.
 * On success it closes as soon as the native host has accepted the capture.
 * Hold and failure states stay visible because they require the user's
 * attention.
 */

type SaveState =
  | { phase: 'idle' }
  | { phase: 'working'; step: CaptureFlowPhase }
  | { phase: 'held'; result: FlushResult }
  | { phase: 'failed'; message: string }
  | { phase: 'summary-failed'; message: string; result?: FlushResult | undefined }

const RELEASES_URL = 'https://github.com/team-reflect/reflect-open/releases/latest'

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
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

function CheckIcon(): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path
        d="m3.25 8.25 3 3 6.5-6.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Spinner(): ReactElement {
  return <span aria-hidden="true" className="capture-spinner size-3.5 rounded-full border" />
}

function workingButtonLabel(step: CaptureFlowPhase, downloadingModel: boolean): string {
  switch (step) {
    case 'saving-link':
      return 'Saving link…'
    case 'extracting-page':
      return 'Reading page…'
    case 'generating-summary':
      return downloadingModel ? 'Downloading…' : 'Generating summary…'
    case 'saving-page-text':
      return 'Saving page text…'
    case 'saving-update':
      return 'Adding summary…'
  }
}

export function CapturePopup(): ReactElement {
  const captured = useCapturedPage()
  const [note, setNote] = useState('')
  const [includePageText, setIncludePageText] = useState(false)
  const [includePageSummary, setIncludePageSummary] = useState(false)
  const includePageTextTouched = useRef(false)
  const includePageSummaryTouched = useRef(false)
  const [includePageTextPreferenceLoaded, setIncludePageTextPreferenceLoaded] = useState(false)
  const [includePageSummaryPreferenceLoaded, setIncludePageSummaryPreferenceLoaded] =
    useState(false)
  const [summaryAvailability, setSummaryAvailability] = useState<
    PageSummaryAvailability | 'checking'
  >('checking')
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const activeSummaryTask = useRef<PageSummaryTask | null>(null)
  const [save, setSave] = useState<SaveState>({ phase: 'idle' })
  const [heldCount, setHeldCount] = useState(0)

  useEffect(() => {
    void readQueue().then((queue) => setHeldCount(queue.length))
  }, [])

  useEffect(() => {
    let cancelled = false
    void pageSummaryAvailability().then(
      (availability) => {
        if (!cancelled) {
          setSummaryAvailability(availability)
        }
      },
      (cause) => {
        console.warn('Chrome page summary availability could not be read:', cause)
        if (!cancelled) {
          setSummaryAvailability('unavailable')
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      activeSummaryTask.current?.cancel()
    },
    [],
  )

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

  useEffect(() => {
    let cancelled = false
    void readIncludePageSummaryPreference().then(
      (preference) => {
        if (!cancelled && !includePageSummaryTouched.current) {
          setIncludePageSummary(preference)
        }
        if (!cancelled) {
          setIncludePageSummaryPreferenceLoaded(true)
        }
      },
      (cause) => {
        console.warn('capture page summary preference could not be read:', cause)
        if (!cancelled) {
          setIncludePageSummaryPreferenceLoaded(true)
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
      !includePageSummaryPreferenceLoaded ||
      save.phase === 'working' ||
      save.phase === 'summary-failed'
    ) {
      return
    }
    const canSummarize =
      summaryAvailability === 'available' ||
      summaryAvailability === 'downloadable' ||
      summaryAvailability === 'downloading'
    const shouldSummarize = includePageSummary && canSummarize
    setDownloadProgress(null)
    setSave({ phase: 'working', step: shouldSummarize ? 'saving-link' : 'extracting-page' })
    try {
      const result = await runCaptureFlow(
        {
          page: captured.page,
          tabId: captured.tabId,
          note,
          includePageText,
          includePageSummary: shouldSummarize,
        },
        {
          onPhase: (step) => setSave({ phase: 'working', step }),
          onDownloadProgress: setDownloadProgress,
        },
        {
          now: () => new Date(),
          randomId: () => crypto.randomUUID(),
          extractPageText: tryExtractPageText,
          saveCapture: (page) =>
            saveCapture(page, () => browser.runtime.sendMessage({ type: 'flush' })),
          startPageSummary: (options) => {
            const task = startPageSummary(options)
            activeSummaryTask.current = task
            return task
          },
        },
      )
      activeSummaryTask.current = null
      if (result.kind === 'link-rejected') {
        setSave({ phase: 'failed', message: 'The capture was rejected — please report this.' })
      } else if (result.kind === 'update-rejected') {
        setSave({
          phase: 'summary-failed',
          message: 'Link captured, but the capture update was rejected — please report this.',
          result: result.linkOutcome.fate === 'held' ? result.linkOutcome.result : undefined,
        })
      } else if (result.kind === 'summary-failed') {
        const lastOutcome = result.pageTextOutcome ?? result.linkOutcome
        setSave({
          phase: 'summary-failed',
          message: `Link captured, but the summary could not be generated: ${errorMessage(result.cause)}`,
          result: lastOutcome.fate === 'held' ? lastOutcome.result : undefined,
        })
      } else if (result.outcome.fate === 'queued') {
        window.close()
      } else if (result.outcome.fate === 'held') {
        setSave({ phase: 'held', result: result.outcome.result })
        setHeldCount(result.outcome.result.held)
      } else {
        setSave({ phase: 'failed', message: 'The capture was rejected — please report this.' })
      }
    } catch (cause) {
      activeSummaryTask.current?.cancel()
      activeSummaryTask.current = null
      setSave({ phase: 'failed', message: errorMessage(cause) })
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
  const summarySupported =
    summaryAvailability === 'available' ||
    summaryAvailability === 'downloadable' ||
    summaryAvailability === 'downloading'
  const waitingForSummaryAvailability = includePageSummary && summaryAvailability === 'checking'
  const summaryRequested = includePageSummary && summarySupported
  const downloadingModel = downloadProgress !== null && downloadProgress < 100
  const linkCaptured = save.phase === 'working' && summaryRequested && save.step !== 'saving-link'
  const showWorkingStatus =
    save.phase === 'working' && summaryRequested && (linkCaptured || downloadingModel)
  const busy =
    save.phase === 'working' ||
    !includePageTextPreferenceLoaded ||
    !includePageSummaryPreferenceLoaded ||
    waitingForSummaryAvailability
  const lockedAfterSummaryFailure = save.phase === 'summary-failed'
  const captureOptionsDisabled = busy || lockedAfterSummaryFailure
  const summaryOptionDisabled = captureOptionsDisabled || !summarySupported

  function onIncludePageTextChange(checked: boolean): void {
    includePageTextTouched.current = true
    setIncludePageTextPreferenceLoaded(true)
    setIncludePageText(checked)
    void writeIncludePageTextPreference(checked).catch((cause) => {
      console.warn('capture page text preference could not be saved:', cause)
    })
  }

  function onIncludePageSummaryChange(checked: boolean): void {
    includePageSummaryTouched.current = true
    setIncludePageSummaryPreferenceLoaded(true)
    setIncludePageSummary(checked)
    void writeIncludePageSummaryPreference(checked).catch((cause) => {
      console.warn('capture page summary preference could not be saved:', cause)
    })
  }

  const buttonLabel =
    save.phase === 'working'
      ? workingButtonLabel(save.step, downloadingModel)
      : waitingForSummaryAvailability
        ? 'Checking summarizer…'
        : !includePageTextPreferenceLoaded || !includePageSummaryPreferenceLoaded
          ? 'Loading…'
          : save.phase === 'summary-failed'
            ? 'Link captured'
            : 'Save to Reflect'
  const showButtonSpinner = busy

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
        disabled={captureOptionsDisabled}
        className="rounded-md border border-border bg-input-bg px-2 py-1.5 text-sm text-text outline-none placeholder:text-text-muted focus:ring-2 focus:ring-focus-ring"
      />
      <div className="flex flex-col gap-0.5">
        <label
          className="capture-option -mx-1 flex min-h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium text-text"
          data-disabled={captureOptionsDisabled}
        >
          <input
            type="checkbox"
            checked={includePageText}
            onChange={(event) => onIncludePageTextChange(event.target.checked)}
            disabled={captureOptionsDisabled}
            className="size-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
          />
          <span className="min-w-0 flex-1">Capture page text</span>
        </label>
        <label
          className="capture-option -mx-1 flex min-h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium text-text"
          data-disabled={summaryOptionDisabled}
          title={
            summarySupported
              ? 'Runs locally with Chrome built-in AI'
              : 'Chrome built-in page summaries are unavailable on this device'
          }
        >
          <input
            type="checkbox"
            checked={summarySupported && includePageSummary}
            onChange={(event) => onIncludePageSummaryChange(event.target.checked)}
            disabled={summaryOptionDisabled}
            className="size-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
          />
          <span className="min-w-0 flex-1">Capture page summary</span>
          {summaryAvailability === 'unsupported' ? (
            <span className="text-[11px] font-normal text-text-muted">Chrome 138+</span>
          ) : summaryAvailability === 'unavailable' ? (
            <span className="text-[11px] font-normal text-text-muted">Unavailable</span>
          ) : null}
        </label>
      </div>
      <button
        type="submit"
        disabled={captureOptionsDisabled}
        className="capture-button h-8 w-full rounded-lg bg-accent px-3 text-sm font-medium text-text-on-brand disabled:opacity-60"
      >
        <span
          key={buttonLabel}
          className="capture-state-enter inline-flex items-center justify-center gap-2"
        >
          {showButtonSpinner ? <Spinner /> : null}
          <span>{buttonLabel}</span>
        </span>
      </button>
      {showWorkingStatus ? (
        <div
          key={`${linkCaptured ? 'captured' : 'saving'}-${downloadingModel ? 'downloading' : 'ready'}`}
          className="capture-state-enter flex flex-col gap-2 px-0.5 text-xs text-text-muted"
        >
          {linkCaptured ? (
            <div role="status" className="flex items-center gap-1.5 text-text-secondary">
              <span className="text-accent">
                <CheckIcon />
              </span>
              <span>Link captured</span>
            </div>
          ) : null}
          {downloadingModel ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <span>Downloading summarizer</span>
                <span className="tabular-nums">{downloadProgress}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="Downloading summarizer"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={downloadProgress}
                className="h-0.5 overflow-hidden rounded-full bg-border"
              >
                <div
                  className="capture-progress-fill h-full w-full origin-left rounded-full bg-accent"
                  style={{ transform: `scaleX(${downloadProgress / 100})` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {save.phase === 'held' ? (
        <p className="text-xs text-text-muted">
          {holdMessage(save.result)}{' '}
          {save.result.holdReason === 'no-host' ? (
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              Download Reflect
            </a>
          ) : null}
        </p>
      ) : null}
      {save.phase === 'failed' ? <p className="text-xs text-destructive">{save.message}</p> : null}
      {save.phase === 'summary-failed' ? (
        <p className="text-xs text-destructive">
          {save.message}{' '}
          {save.result ? <span className="text-text-muted">{holdMessage(save.result)}</span> : null}
        </p>
      ) : null}
      {save.phase === 'idle' && heldCount > 0 ? (
        <p className="text-xs text-text-muted">
          {heldCount} earlier {heldCount === 1 ? 'capture' : 'captures'} waiting for Reflect.
        </p>
      ) : null}
    </form>
  )
}
