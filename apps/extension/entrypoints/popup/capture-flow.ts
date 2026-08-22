import type { BuildWireMessageInput, CapturedPage } from '@/lib/capture-message'
import type { PageSummaryTask } from '@/lib/page-summary'
import type { SaveOutcome } from '@/lib/save-capture'

export type CaptureFlowPhase =
  | 'extracting-page'
  | 'saving-link'
  | 'generating-summary'
  | 'saving-update'

export interface CaptureFlowInput {
  page: CapturedPage
  tabId: number
  note: string
  includePageText: boolean
  includePageSummary: boolean
}

export interface CaptureFlowCallbacks {
  onPhase: (phase: CaptureFlowPhase) => void
  onDownloadProgress: (progress: number) => void
}

export interface CaptureFlowDependencies {
  now: () => Date
  randomId: () => string
  extractPageText: (tabId: number, expectedUrl: string) => Promise<string | undefined>
  saveCapture: (capture: BuildWireMessageInput) => Promise<SaveOutcome>
  startPageSummary: (options: {
    title: string
    onDownloadProgress: (progress: number) => void
  }) => PageSummaryTask
}

export type CaptureFlowResult =
  | { kind: 'saved'; outcome: SaveOutcome }
  | { kind: 'link-rejected' }
  | { kind: 'update-rejected'; linkOutcome: SaveOutcome }
  | {
      kind: 'summary-failed'
      cause: unknown
      linkOutcome: SaveOutcome
      pageTextOutcome?: SaveOutcome | undefined
    }

function captureInput(
  input: CaptureFlowInput,
  dependencies: CaptureFlowDependencies,
  capturedAt: Date,
  extras: { contentText?: string | undefined; summary?: string | undefined } = {},
): BuildWireMessageInput {
  return {
    ...input.page,
    ...extras,
    note: input.note,
    id: dependencies.randomId(),
    capturedAt,
  }
}

/**
 * Capture with popup-selected options. Summary captures are deliberately
 * two-phase: the raw link is durable before page extraction or local model
 * work begins, then a same-day recapture refreshes that note in place.
 */
export async function runCaptureFlow(
  input: CaptureFlowInput,
  callbacks: CaptureFlowCallbacks,
  dependencies: CaptureFlowDependencies,
): Promise<CaptureFlowResult> {
  const capturedAt = dependencies.now()
  const summaryTask = input.includePageSummary
    ? dependencies.startPageSummary({
        title: input.page.title,
        onDownloadProgress: callbacks.onDownloadProgress,
      })
    : null

  if (summaryTask === null) {
    callbacks.onPhase(input.includePageText ? 'extracting-page' : 'saving-link')
    const contentText = input.includePageText
      ? await dependencies.extractPageText(input.tabId, input.page.url)
      : undefined
    callbacks.onPhase('saving-link')
    const outcome = await dependencies.saveCapture(
      captureInput(input, dependencies, capturedAt, { contentText }),
    )
    return outcome.fate === 'rejected' ? { kind: 'link-rejected' } : { kind: 'saved', outcome }
  }

  callbacks.onPhase('saving-link')
  const linkOutcome = await dependencies.saveCapture(captureInput(input, dependencies, capturedAt))
  if (linkOutcome.fate === 'rejected') {
    summaryTask.cancel()
    return { kind: 'link-rejected' }
  }

  callbacks.onPhase('extracting-page')
  const contentText = await dependencies.extractPageText(input.tabId, input.page.url)
  if (contentText === undefined) {
    summaryTask.cancel()
    return {
      kind: 'summary-failed',
      cause: new Error('The page did not contain any readable text to summarize'),
      linkOutcome,
    }
  }

  callbacks.onPhase('generating-summary')
  let summary: string
  try {
    summary = await summaryTask.summarize(contentText)
  } catch (cause) {
    if (!input.includePageText) {
      return { kind: 'summary-failed', cause, linkOutcome }
    }
    callbacks.onPhase('saving-update')
    const pageTextOutcome = await dependencies.saveCapture(
      captureInput(input, dependencies, capturedAt, { contentText }),
    )
    return { kind: 'summary-failed', cause, linkOutcome, pageTextOutcome }
  }

  callbacks.onPhase('saving-update')
  const updateOutcome = await dependencies.saveCapture(
    captureInput(input, dependencies, capturedAt, {
      contentText: input.includePageText ? contentText : undefined,
      summary,
    }),
  )
  return updateOutcome.fate === 'rejected'
    ? { kind: 'update-rejected', linkOutcome }
    : { kind: 'saved', outcome: updateOutcome }
}
