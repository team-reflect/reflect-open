import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageSummaryAvailability, startPageSummary, supportsPageSummary } from './page-summary'

function fakeSummarizer(overrides: Record<string, unknown> = {}) {
  return {
    inputQuota: 1_000,
    measureInputUsage: vi.fn((input: string) => Promise.resolve(input.length)),
    summarize: vi.fn((_input: string) => Promise.resolve('- A concise key point')),
    destroy: vi.fn(),
    ...overrides,
  }
}

function installSummarizerApi(summarizer: ReturnType<typeof fakeSummarizer>) {
  const availability = vi.fn<() => Promise<Availability>>().mockResolvedValue('available')
  const create = vi.fn((options?: SummarizerCreateOptions) => {
    if (options?.monitor) {
      const monitor = new EventTarget()
      Object.defineProperty(monitor, 'ondownloadprogress', { value: null, writable: true })
      options.monitor(monitor as CreateMonitor)
      const progress = new Event('downloadprogress')
      Object.defineProperty(progress, 'loaded', { value: 0.42 })
      monitor.dispatchEvent(progress)
    }
    return Promise.resolve(summarizer)
  })
  vi.stubGlobal('Summarizer', { availability, create })
  return { availability, create }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('page summary availability', () => {
  it('reports unsupported when Chrome does not expose the API', async () => {
    expect(supportsPageSummary()).toBe(false)
    await expect(pageSummaryAvailability()).resolves.toBe('unsupported')
  })

  it('forwards Chrome model availability with the configured summary shape', async () => {
    const api = installSummarizerApi(fakeSummarizer())
    api.availability.mockResolvedValue('downloadable')

    await expect(pageSummaryAvailability()).resolves.toBe('downloadable')
    expect(api.availability).toHaveBeenCalledWith({
      type: 'key-points',
      format: 'markdown',
      length: 'medium',
      preference: 'auto',
    })
  })
})

describe('startPageSummary', () => {
  it('creates the configured session, reports download progress, and releases it', async () => {
    const summarizer = fakeSummarizer()
    const api = installSummarizerApi(summarizer)
    const onDownloadProgress = vi.fn()

    const task = startPageSummary({ title: 'An article', onDownloadProgress })
    await expect(task.summarize(' First paragraph. ')).resolves.toBe('- A concise key point')

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'key-points',
        format: 'markdown',
        length: 'medium',
        preference: 'auto',
        sharedContext: 'Readable text from a web page titled "An article".',
      }),
    )
    expect(onDownloadProgress).toHaveBeenCalledWith(42)
    expect(summarizer.measureInputUsage).toHaveBeenCalledWith('First paragraph.')
    expect(summarizer.summarize).toHaveBeenCalledWith(
      'First paragraph.',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(summarizer.destroy).toHaveBeenCalledOnce()
  })

  it('trims over-quota input at a text boundary with headroom', async () => {
    const summarize = vi.fn((_input: string) => Promise.resolve('- Summary'))
    const summarizer = fakeSummarizer({ inputQuota: 45, summarize })
    installSummarizerApi(summarizer)
    const input =
      'First paragraph contains the important introduction.\n\nSecond paragraph adds details that will not fit.'

    await startPageSummary({ title: 'Long article' }).summarize(input)

    const summarizedInput = summarize.mock.calls[0]?.[0]
    expect(typeof summarizedInput).toBe('string')
    expect(summarizedInput?.length).toBeLessThanOrEqual(45)
    expect(summarizedInput).toBe('First paragraph contains the important')
  })

  it('hard-trims instead of collapsing to an early word boundary', async () => {
    const summarize = vi.fn((_input: string) => Promise.resolve('- Summary'))
    const summarizer = fakeSummarizer({ inputQuota: 50, summarize })
    installSummarizerApi(summarizer)

    await startPageSummary({ title: 'Blob-heavy article' }).summarize(`A ${'x'.repeat(200)}`)

    expect(summarize.mock.calls[0]?.[0]).toHaveLength(45)
    expect(summarize.mock.calls[0]?.[0].startsWith('A ')).toBe(true)
  })

  it('rejects blank model output and still releases the session', async () => {
    const summarizer = fakeSummarizer({
      summarize: vi.fn((_input: string) => Promise.resolve('  ')),
    })
    installSummarizerApi(summarizer)

    await expect(startPageSummary({ title: 'Article' }).summarize('Readable text')).rejects.toEqual(
      new Error('Chrome returned an empty summary'),
    )
    expect(summarizer.destroy).toHaveBeenCalledOnce()
  })

  it('aborts pending model creation and destroys a session that arrives afterward', async () => {
    const summarizer = fakeSummarizer()
    let resolveCreation: ((value: ReturnType<typeof fakeSummarizer>) => void) | undefined
    const creation = new Promise<ReturnType<typeof fakeSummarizer>>((resolve) => {
      resolveCreation = resolve
    })
    vi.stubGlobal('Summarizer', {
      availability: vi.fn(() => Promise.resolve('available')),
      create: vi.fn(() => creation),
    })

    const task = startPageSummary({ title: 'Article' })
    task.cancel()
    resolveCreation?.(summarizer)

    await expect(task.summarize('Readable text')).rejects.toMatchObject({ name: 'AbortError' })
    expect(summarizer.destroy).toHaveBeenCalledOnce()
  })
})
