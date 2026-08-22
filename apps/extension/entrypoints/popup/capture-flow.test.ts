import { describe, expect, it, vi } from 'vitest'
import type { PageSummaryTask } from '@/lib/page-summary'
import type { SaveOutcome } from '@/lib/save-capture'
import {
  runCaptureFlow,
  type CaptureFlowCallbacks,
  type CaptureFlowDependencies,
  type CaptureFlowInput,
} from './capture-flow'

const CAPTURED_AT = new Date('2026-08-22T09:30:00.000Z')
const FIRST_ID = '00000000-0000-4000-8000-000000000001'
const SECOND_ID = '00000000-0000-4000-8000-000000000002'
const QUEUED: SaveOutcome = { fate: 'queued' }

const INPUT: CaptureFlowInput = {
  page: {
    url: 'https://example.com/article',
    title: 'An article',
    selection: 'quoted text',
    screenshotDataUrl: 'data:image/jpeg;base64,aGVsbG8=',
  },
  tabId: 42,
  note: 'read later',
  includePageText: false,
  includePageSummary: true,
}

function callbacks(): CaptureFlowCallbacks & {
  phases: ReturnType<typeof vi.fn<CaptureFlowCallbacks['onPhase']>>
} {
  const phases = vi.fn<CaptureFlowCallbacks['onPhase']>()
  return { onPhase: phases, phases, onDownloadProgress: vi.fn() }
}

function dependencies(overrides: Partial<CaptureFlowDependencies> = {}): {
  dependencies: CaptureFlowDependencies
  saveCapture: ReturnType<typeof vi.fn<CaptureFlowDependencies['saveCapture']>>
  summarize: ReturnType<typeof vi.fn<PageSummaryTask['summarize']>>
  cancel: ReturnType<typeof vi.fn<PageSummaryTask['cancel']>>
} {
  const saveCapture = vi.fn<CaptureFlowDependencies['saveCapture']>().mockResolvedValue(QUEUED)
  const summarize = vi
    .fn<PageSummaryTask['summarize']>()
    .mockResolvedValue('- First key point\n- Second key point')
  const cancel = vi.fn<PageSummaryTask['cancel']>()
  const ids = [FIRST_ID, SECOND_ID]
  const defaults: CaptureFlowDependencies = {
    now: () => CAPTURED_AT,
    randomId: () => ids.shift() ?? crypto.randomUUID(),
    extractPageText: vi.fn().mockResolvedValue('First paragraph.\n\nSecond paragraph.'),
    saveCapture,
    startPageSummary: () => ({ summarize, cancel }),
  }
  return {
    dependencies: { ...defaults, ...overrides },
    saveCapture,
    summarize,
    cancel,
  }
}

describe('runCaptureFlow', () => {
  it('queues the raw link before extraction, then sends a same-time summary update', async () => {
    let resolvePageText: ((value: string | undefined) => void) | undefined
    const pageText = new Promise<string | undefined>((resolve) => {
      resolvePageText = resolve
    })
    const setup = dependencies({ extractPageText: () => pageText })
    const events = callbacks()

    const resultPromise = runCaptureFlow(INPUT, events, setup.dependencies)

    expect(setup.saveCapture).toHaveBeenCalledOnce()
    expect(setup.saveCapture.mock.calls[0]?.[0]).toMatchObject({
      id: FIRST_ID,
      capturedAt: CAPTURED_AT,
      url: INPUT.page.url,
      selection: INPUT.page.selection,
      screenshotDataUrl: INPUT.page.screenshotDataUrl,
      note: INPUT.note,
    })
    expect(setup.saveCapture.mock.calls[0]?.[0].contentText).toBeUndefined()
    expect(setup.saveCapture.mock.calls[0]?.[0].summary).toBeUndefined()

    resolvePageText?.('First paragraph.\n\nSecond paragraph.')
    await expect(resultPromise).resolves.toEqual({ kind: 'saved', outcome: QUEUED })

    expect(setup.saveCapture).toHaveBeenCalledTimes(2)
    expect(setup.saveCapture.mock.calls[1]?.[0]).toMatchObject({
      id: SECOND_ID,
      capturedAt: CAPTURED_AT,
      summary: '- First key point\n- Second key point',
    })
    expect(setup.saveCapture.mock.calls[1]?.[0].contentText).toBeUndefined()
    expect(events.phases.mock.calls.map(([phase]) => phase)).toEqual([
      'saving-link',
      'extracting-page',
      'generating-summary',
      'saving-update',
    ])
  })

  it('captures page text and summary together when both options are selected', async () => {
    const setup = dependencies()

    await runCaptureFlow({ ...INPUT, includePageText: true }, callbacks(), setup.dependencies)

    expect(setup.saveCapture.mock.calls[1]?.[0]).toMatchObject({
      contentText: 'First paragraph.\n\nSecond paragraph.',
      summary: '- First key point\n- Second key point',
    })
  })

  it('keeps the existing single-phase page-text capture when summary is off', async () => {
    const setup = dependencies()

    await expect(
      runCaptureFlow(
        { ...INPUT, includePageText: true, includePageSummary: false },
        callbacks(),
        setup.dependencies,
      ),
    ).resolves.toEqual({ kind: 'saved', outcome: QUEUED })

    expect(setup.saveCapture).toHaveBeenCalledOnce()
    expect(setup.saveCapture.mock.calls[0]?.[0].contentText).toBe(
      'First paragraph.\n\nSecond paragraph.',
    )
    expect(setup.summarize).not.toHaveBeenCalled()
  })

  it('still saves requested page text when summary generation fails', async () => {
    const summaryFailure = new Error('model failed')
    const summarize = vi.fn<PageSummaryTask['summarize']>().mockRejectedValue(summaryFailure)
    const setup = dependencies({ startPageSummary: () => ({ summarize, cancel: vi.fn() }) })

    const result = await runCaptureFlow(
      { ...INPUT, includePageText: true },
      callbacks(),
      setup.dependencies,
    )

    expect(result).toEqual({
      kind: 'summary-failed',
      cause: summaryFailure,
      linkOutcome: QUEUED,
      pageTextOutcome: QUEUED,
    })
    expect(setup.saveCapture).toHaveBeenCalledTimes(2)
    expect(setup.saveCapture.mock.calls[1]?.[0].contentText).toBe(
      'First paragraph.\n\nSecond paragraph.',
    )
    expect(setup.saveCapture.mock.calls[1]?.[0].summary).toBeUndefined()
  })

  it('reports a rejected page-text fallback update instead of implying it landed', async () => {
    const rejected: SaveOutcome = { fate: 'rejected' }
    const summarize = vi
      .fn<PageSummaryTask['summarize']>()
      .mockRejectedValue(new Error('model failed'))
    const setup = dependencies({ startPageSummary: () => ({ summarize, cancel: vi.fn() }) })
    setup.saveCapture.mockResolvedValueOnce(QUEUED).mockResolvedValueOnce(rejected)

    await expect(
      runCaptureFlow({ ...INPUT, includePageText: true }, callbacks(), setup.dependencies),
    ).resolves.toEqual({ kind: 'update-rejected', linkOutcome: QUEUED })
  })

  it('cancels model work when extraction returns no readable page text', async () => {
    const setup = dependencies({ extractPageText: vi.fn().mockResolvedValue(undefined) })

    const result = await runCaptureFlow(INPUT, callbacks(), setup.dependencies)

    expect(result).toMatchObject({ kind: 'summary-failed', linkOutcome: QUEUED })
    expect(result.kind === 'summary-failed' ? result.cause : null).toEqual(
      new Error('The page did not contain any readable text to summarize'),
    )
    expect(setup.cancel).toHaveBeenCalledOnce()
    expect(setup.summarize).not.toHaveBeenCalled()
    expect(setup.saveCapture).toHaveBeenCalledOnce()
  })

  it('keeps the raw link without an update when a summary-only capture fails', async () => {
    const summaryFailure = new Error('model failed')
    const summarize = vi.fn<PageSummaryTask['summarize']>().mockRejectedValue(summaryFailure)
    const setup = dependencies({ startPageSummary: () => ({ summarize, cancel: vi.fn() }) })

    await expect(runCaptureFlow(INPUT, callbacks(), setup.dependencies)).resolves.toEqual({
      kind: 'summary-failed',
      cause: summaryFailure,
      linkOutcome: QUEUED,
    })
    expect(setup.saveCapture).toHaveBeenCalledOnce()
  })

  it('reports a rejected enrichment update without losing the queued link', async () => {
    const rejected: SaveOutcome = { fate: 'rejected' }
    const setup = dependencies()
    setup.saveCapture.mockResolvedValueOnce(QUEUED).mockResolvedValueOnce(rejected)

    await expect(runCaptureFlow(INPUT, callbacks(), setup.dependencies)).resolves.toEqual({
      kind: 'update-rejected',
      linkOutcome: QUEUED,
    })
    expect(setup.saveCapture).toHaveBeenCalledTimes(2)
  })

  it('cancels model work when the raw link is rejected', async () => {
    const rejected: SaveOutcome = { fate: 'rejected' }
    const saveCapture = vi.fn<CaptureFlowDependencies['saveCapture']>().mockResolvedValue(rejected)
    const setup = dependencies({ saveCapture })

    await expect(runCaptureFlow(INPUT, callbacks(), setup.dependencies)).resolves.toEqual({
      kind: 'link-rejected',
    })
    expect(setup.cancel).toHaveBeenCalledOnce()
    expect(setup.summarize).not.toHaveBeenCalled()
  })
})
