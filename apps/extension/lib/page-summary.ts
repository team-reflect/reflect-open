import { z } from 'zod'

const SUMMARY_OPTIONS = {
  type: 'key-points',
  format: 'markdown',
  length: 'medium',
  preference: 'auto',
} as const satisfies SummarizerCreateCoreOptions

const QUOTA_HEADROOM = 0.9
const MAX_QUOTA_TRIM_ATTEMPTS = 4

const summaryOutputSchema = z.string().trim().min(1, 'Chrome returned an empty summary')
const summaryAvailabilitySchema = z.enum([
  'unavailable',
  'downloadable',
  'downloading',
  'available',
])

/** Chrome model readiness, plus `unsupported` when the API is absent. */
export type PageSummaryAvailability = z.infer<typeof summaryAvailabilitySchema> | 'unsupported'

export interface PageSummaryTask {
  /** Generate one summary and release the browser model session afterward. */
  summarize(contentText: string): Promise<string>
  /** Abort model creation or generation and release an initialized session. */
  cancel(): void
}

/** Context and progress reporting for one user-activated summary session. */
export interface StartPageSummaryOptions {
  /** Page title supplied as model context. */
  title: string
  /** Receives whole-number model download percentages from zero through 100. */
  onDownloadProgress?: ((progress: number) => void) | undefined
}

interface SummarySessionReady {
  ok: true
  summarizer: Summarizer
}

interface SummarySessionFailed {
  ok: false
  cause: unknown
}

type SummarySessionResult = SummarySessionReady | SummarySessionFailed

/** Whether this document exposes Chrome's built-in Summarizer API. */
export function supportsPageSummary(): boolean {
  return 'Summarizer' in globalThis
}

/** Current model readiness, with an explicit state for older Chrome builds. */
export async function pageSummaryAvailability(): Promise<PageSummaryAvailability> {
  if (!supportsPageSummary()) {
    return 'unsupported'
  }
  return summaryAvailabilitySchema.parse(await Summarizer.availability(SUMMARY_OPTIONS))
}

function cancelledError(): DOMException {
  return new DOMException('Page summarization was cancelled', 'AbortError')
}

function truncateAtTextBoundary(text: string, maximumLength: number): string {
  if (text.length <= maximumLength) {
    return text
  }
  const prefix = text.slice(0, Math.max(1, maximumLength))
  const paragraphAt = prefix.lastIndexOf('\n\n')
  const wordAt = prefix.lastIndexOf(' ')
  const boundary = paragraphAt >= prefix.length / 2 ? paragraphAt : wordAt
  return prefix.slice(0, boundary > 0 ? boundary : prefix.length).trimEnd()
}

async function fitToInputQuota(summarizer: Summarizer, contentText: string): Promise<string> {
  const normalized = contentText.trim()
  if (normalized === '') {
    throw new Error('The page did not contain any readable text to summarize')
  }
  const quota = summarizer.inputQuota
  if (!Number.isFinite(quota) || quota <= 0) {
    throw new Error('Chrome reported an invalid summarizer input quota')
  }

  const initialUsage = await summarizer.measureInputUsage(normalized)
  if (initialUsage <= quota) {
    return normalized
  }

  let candidate = truncateAtTextBoundary(
    normalized,
    Math.floor(normalized.length * ((quota * QUOTA_HEADROOM) / initialUsage)),
  )
  for (let attempt = 0; attempt < MAX_QUOTA_TRIM_ATTEMPTS; attempt += 1) {
    const usage = await summarizer.measureInputUsage(candidate)
    if (usage <= quota) {
      return candidate
    }
    candidate = truncateAtTextBoundary(
      candidate,
      Math.floor(candidate.length * ((quota * QUOTA_HEADROOM) / usage)),
    )
  }
  throw new Error('The readable page text is too long for Chrome to summarize')
}

/**
 * Start model initialization while the popup still has transient user activation.
 * The returned task absorbs creation failures until the caller requests its result,
 * so the raw link can finish queueing first without an unhandled rejection.
 */
export function startPageSummary(options: StartPageSummaryOptions): PageSummaryTask {
  const abortController = new AbortController()
  let cancelled = false
  let activeSummarizer: Summarizer | null = null

  const sessionResult: Promise<SummarySessionResult> = supportsPageSummary()
    ? Summarizer.create({
        ...SUMMARY_OPTIONS,
        sharedContext: `Readable text from a web page titled "${options.title.trim()}".`,
        signal: abortController.signal,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            const progress = Math.round(Math.min(1, Math.max(0, event.loaded)) * 100)
            options.onDownloadProgress?.(progress)
          })
        },
      }).then(
        (summarizer): SummarySessionResult => {
          if (cancelled) {
            summarizer.destroy()
            return { ok: false, cause: cancelledError() }
          }
          activeSummarizer = summarizer
          return { ok: true, summarizer }
        },
        (cause: unknown): SummarySessionResult => ({ ok: false, cause }),
      )
    : Promise.resolve({
        ok: false,
        cause: new Error('Page summaries are not supported by this version of Chrome'),
      })

  return {
    async summarize(contentText: string): Promise<string> {
      const result = await sessionResult
      if (!result.ok) {
        throw result.cause
      }
      try {
        const input = await fitToInputQuota(result.summarizer, contentText)
        return summaryOutputSchema.parse(
          await result.summarizer.summarize(input, { signal: abortController.signal }),
        )
      } finally {
        if (activeSummarizer === result.summarizer) {
          result.summarizer.destroy()
          activeSummarizer = null
        }
      }
    },
    cancel(): void {
      cancelled = true
      abortController.abort()
      activeSummarizer?.destroy()
      activeSummarizer = null
    },
  }
}
