import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvidersState } from '../ai/provider-config'
import { describePage, DescriptionRejectedError } from '../ai/describe-page'
import { ReflectError } from '../errors'
import {
  captureInboxList,
  captureInboxRead,
  captureInboxReject,
  captureInboxRemove,
  listFiles,
  promoteCaptureScreenshot,
  readAsset,
  readNote,
  writeNote,
} from '../graph/commands'
import { getSecret } from '../secrets/keychain'
import {
  captureFromPath,
  captureIdentity,
  drainCaptureInbox,
  isCaptureSpoolPath,
  reconcileCaptureEnrichment,
  type ReconcileCaptureEnrichmentInput,
} from './capture'
import type { CaptureEnvelope } from './capture-envelope'
import { scrapePageMeta } from './meta-scrape'

vi.mock('../graph/commands', () => ({
  captureInboxList: vi.fn(),
  captureInboxRead: vi.fn(),
  captureInboxReject: vi.fn(),
  captureInboxRemove: vi.fn(),
  listFiles: vi.fn(),
  promoteCaptureScreenshot: vi.fn(),
  readAsset: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('./meta-scrape', () => ({
  scrapePageMeta: vi.fn(),
}))
vi.mock('../ai/describe-page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/describe-page')>()),
  describePage: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))

const inboxListMock = vi.mocked(captureInboxList)
const inboxReadMock = vi.mocked(captureInboxRead)
const inboxRejectMock = vi.mocked(captureInboxReject)
const inboxRemoveMock = vi.mocked(captureInboxRemove)
const listFilesMock = vi.mocked(listFiles)
const promoteMock = vi.mocked(promoteCaptureScreenshot)
const readAssetMock = vi.mocked(readAsset)
const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const scrapeMock = vi.mocked(scrapePageMeta)
const describeMock = vi.mocked(describePage)
const getSecretMock = vi.mocked(getSecret)

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.5', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}
const NO_PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }

/** 2026-06-11 15:30:22.845 local — every derived name is asserted from it. */
const CAPTURED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const IDENTITY = captureIdentity(CAPTURED_AT, '7c9e6679-7425-40de-944b-e07fc1f90ae7')
const DAILY = 'daily/2026-06-11.md'
const URL = 'https://example.com/article'

const notFound = () => ({ kind: 'notFound', message: 'missing' })

/**
 * In-memory graph + spool. The mocked commands read/write these maps, so a
 * drain's writes are visible to its own dedup lookups, to later drains, and
 * to the enrichment pass — the cross-step behavior the contract is about.
 */
const files = new Map<string, string>()
const spool = new Map<string, { contents: string; modifiedMs: number }>()
/** What `captureInboxReject` moved into `.reflect/inbox-rejected/`. */
const rejected = new Map<string, string>()

function envelope(overrides: Partial<CaptureEnvelope> = {}): CaptureEnvelope {
  return {
    version: 1,
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    url: URL,
    title: 'An article',
    capturedAt: CAPTURED_AT.toISOString(),
    source: 'extension',
    ...overrides,
  }
}

/** Spool one capture (envelope JSON + screenshot sibling unless disabled). */
function addSpool(
  capture: CaptureEnvelope,
  options: { screenshot?: boolean; modifiedMs?: number } = {},
): void {
  const withRef = {
    ...capture,
    screenshotRef: options.screenshot === false ? undefined : `${capture.id}.jpg`,
  }
  spool.set(`${capture.id}.json`, {
    contents: JSON.stringify(withRef),
    modifiedMs: options.modifiedMs ?? 0,
  })
  if (options.screenshot !== false) {
    spool.set(`${capture.id}.jpg`, { contents: 'jpeg', modifiedMs: options.modifiedMs ?? 0 })
  }
}

function drain(overrides: Partial<Parameters<typeof drainCaptureInbox>[0]> = {}) {
  return drainCaptureInbox({ generation: 3, ...overrides })
}

function reconcile(overrides: Partial<ReconcileCaptureEnrichmentInput> = {}) {
  return reconcileCaptureEnrichment({ providers: PROVIDERS, generation: 3, ...overrides })
}

beforeEach(() => {
  vi.clearAllMocks()
  files.clear()
  spool.clear()
  rejected.clear()

  inboxListMock.mockImplementation(async () =>
    [...spool.entries()].map(([name, entry]) => ({
      path: `.reflect/inbox/${name}`,
      size: entry.contents.length,
      modifiedMs: entry.modifiedMs,
    })),
  )
  inboxReadMock.mockImplementation(async (name) => {
    const entry = spool.get(name)
    if (!entry) throw notFound()
    return entry.contents
  })
  inboxRemoveMock.mockImplementation(async (name) => {
    spool.delete(name)
  })
  inboxRejectMock.mockImplementation(async (name) => {
    const entry = spool.get(name)
    if (entry) {
      rejected.set(name, entry.contents)
      spool.delete(name)
    }
  })
  promoteMock.mockImplementation(async (spoolName) => {
    if (!spool.has(spoolName)) throw notFound()
  })
  readNoteMock.mockImplementation(async (path) => {
    const contents = files.get(path)
    if (contents === undefined) throw notFound()
    return contents
  })
  writeNoteMock.mockImplementation(async (path, contents) => {
    files.set(path, contents)
  })
  listFilesMock.mockImplementation(async () =>
    [...files.keys()].map((path) => ({ path, size: 1, modifiedMs: 0 })),
  )
  readAssetMock.mockResolvedValue(btoa('jpeg-bytes'))
  getSecretMock.mockResolvedValue('sk-live-key')
  scrapeMock.mockResolvedValue({ title: 'An article', description: null, siteName: null })
  describeMock.mockResolvedValue('An AI description of the page.')
})

describe('captureIdentity', () => {
  it('derives every name from the capture moment (local time) plus the envelope id', () => {
    expect(IDENTITY).toEqual({
      base: 'capture-2026-06-11-153022-845-7c9e',
      date: '2026-06-11',
      notePath: 'notes/capture-2026-06-11-153022-845-7c9e.md',
      assetPath: 'assets/capture-2026-06-11-153022-845-7c9e.jpg',
    })
  })

  it('two envelopes stamped in the same millisecond get distinct identities', () => {
    const other = captureIdentity(CAPTURED_AT, 'ffff0000-0000-4000-8000-000000000001')
    expect(other.base).toBe('capture-2026-06-11-153022-845-ffff')
    expect(other.notePath).not.toBe(IDENTITY.notePath)
  })
})

describe('captureFromPath', () => {
  it('round-trips the identity from the note path', () => {
    expect(captureFromPath(IDENTITY.notePath)).toEqual(IDENTITY)
  })

  it('rejects everything that is not a well-formed capture note', () => {
    expect(captureFromPath('notes/capture-the-flag.md')).toBeNull()
    expect(captureFromPath('notes/capture-2026-06-11-153022-845.md')).toBeNull() // no id suffix
    expect(captureFromPath('notes/capture-2026-13-40-153022-845-7c9e.md')).toBeNull()
    expect(captureFromPath('notes/capture-2026-06-11-993022-845-7c9e.md')).toBeNull()
    expect(captureFromPath('daily/capture-2026-06-11-153022-845-7c9e.md')).toBeNull()
    expect(captureFromPath('notes/audio-memo-2026-06-11-153022-845.md')).toBeNull()
  })
})

describe('isCaptureSpoolPath', () => {
  it('matches only inbox envelopes', () => {
    expect(isCaptureSpoolPath('.reflect/inbox/7c9e6679.json')).toBe(true)
    expect(isCaptureSpoolPath('.reflect/inbox/7c9e6679.jpg')).toBe(false)
    expect(isCaptureSpoolPath('notes/a.json')).toBe(false)
  })
})

describe('drainCaptureInbox', () => {
  it('writes the capture note, daily entry, and asset — then removes the spool', async () => {
    addSpool(envelope({ selection: 'quoted text', note: 'check later' }))

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    expect(promoteMock).toHaveBeenCalledWith(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg',
      IDENTITY.assetPath,
      1600,
      3,
    )
    const note = files.get(IDENTITY.notePath)
    expect(note).toContain('captureUrl: https://example.com/article')
    expect(note).toContain('captureStatus: pending')
    expect(note).toContain('captureScreenshot: assets/capture-2026-06-11-153022-845-7c9e.jpg')
    expect(note).toContain('# An article')
    expect(note).toContain('[example.com](https://example.com/article)')
    expect(note).toContain('check later')
    expect(note).toContain('> quoted text')
    expect(note).toContain(`![An article](${IDENTITY.assetPath})`)

    const daily = files.get(DAILY)
    expect(daily).toContain('## Links')
    expect(daily).toContain('[[capture-2026-06-11-153022-845-7c9e|An article]]')
    expect(spool.size).toBe(0)
  })

  it('removes the spool only after the note and daily entry are written', async () => {
    addSpool(envelope())
    await drain()
    const lastWrite = Math.max(...writeNoteMock.mock.invocationCallOrder)
    const firstRemove = Math.min(...inboxRemoveMock.mock.invocationCallOrder)
    expect(firstRemove).toBeGreaterThan(lastWrite)
  })

  it('drains a batch that arrived while the app was closed, oldest first', async () => {
    addSpool(envelope({ id: '00000000-0000-4000-8000-000000000002', url: 'https://b.com' }), {
      modifiedMs: 200,
    })
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        url: 'https://a.com',
        capturedAt: new Date(2026, 5, 11, 9, 0, 0, 0).toISOString(),
      }),
      { modifiedMs: 100 },
    )

    const outcome = await drain()

    expect(outcome.drained).toBe(2)
    const daily = files.get(DAILY) ?? ''
    expect(daily.indexOf('capture-2026-06-11-090000-000')).toBeLessThan(
      daily.indexOf('capture-2026-06-11-153022-845'),
    )
    expect(spool.size).toBe(0)
  })

  it('appends to the existing Links section without duplicating it', async () => {
    files.set(DAILY, '# plans\n\n## Links\n\n[[capture-2026-06-11-090000-000-0000|Old]]\n')
    addSpool(envelope())

    await drain()

    const daily = files.get(DAILY) ?? ''
    expect(daily.match(/## Links/g)).toHaveLength(1)
    expect(daily).toContain('[[capture-2026-06-11-090000-000-0000|Old]]')
    expect(daily).toContain('[[capture-2026-06-11-153022-845-7c9e|An article]]')
  })

  it('saves a private-day capture raw, marked skipped', async () => {
    files.set(DAILY, '---\nprivate: true\n---\n\nsecret plans\n')
    addSpool(envelope())

    const outcome = await drain()

    expect(outcome.drained).toBe(1)
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(files.get(DAILY)).toContain('[[capture-2026-06-11-153022-845-7c9e|An article]]')
  })

  it('refreshes a same-day same-URL same-selection re-capture in place', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    const originalNotePath = 'notes/capture-2026-06-11-093000-000-0000.md'
    expect(files.has(originalNotePath)).toBe(true)

    addSpool(envelope()) // same URL, no selection, same day, 15:30
    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    // The existing identity is reused — no orphan note under the new stamp.
    expect(files.has(IDENTITY.notePath)).toBe(false)
    expect(files.get(originalNotePath)).toContain('captureStatus: pending')
    expect(promoteMock).toHaveBeenLastCalledWith(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg',
      'assets/capture-2026-06-11-093000-000-0000.jpg',
      1600,
      3,
    )
    const daily = files.get(DAILY) ?? ''
    expect(daily.match(/capture-2026-06-11-093000-000-0000/g)).toHaveLength(1)
    expect(daily).not.toContain('capture-2026-06-11-153022-845')
  })

  it('a different selection creates a new entry instead of refreshing', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()

    addSpool(envelope({ selection: 'a fresh highlight' }))
    const outcome = await drain()

    expect(outcome.deduped).toBe(0)
    expect(files.has(IDENTITY.notePath)).toBe(true)
    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain('capture-2026-06-11-093000-000')
    expect(daily).toContain('capture-2026-06-11-153022-845')
  })

  it('re-drains idempotently after a crash between note write and spool removal', async () => {
    addSpool(envelope())
    await drain()
    // Simulate the crashed pass: the spool files are back (never removed).
    addSpool(envelope())

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    const daily = files.get(DAILY) ?? ''
    expect(daily.match(/capture-2026-06-11-153022-845/g)).toHaveLength(1)
  })

  it('quarantines an unparseable spool file instead of wedging the queue or deleting it', async () => {
    spool.set('garbage.json', { contents: 'not json', modifiedMs: 0 })
    addSpool(envelope({ id: '00000000-0000-4000-8000-000000000001' }))

    const outcome = await drain()

    expect(outcome.invalid).toBe(1)
    expect(outcome.drained).toBe(1)
    expect(spool.has('garbage.json')).toBe(false)
    // Moved, never deleted — a newer extension's envelope must survive an
    // older app that can't parse it yet.
    expect(rejected.get('garbage.json')).toBe('not json')
    expect(inboxRemoveMock).not.toHaveBeenCalledWith('garbage.json', 3)
    expect(writeNoteMock).toHaveBeenCalled()
  })

  it('drains two same-millisecond captures of different pages into distinct notes', async () => {
    addSpool(
      envelope({ id: '00000000-0000-4000-8000-000000000001', url: 'https://a.com' }),
      { screenshot: false },
    )
    addSpool(
      envelope({ id: 'ffff0000-0000-4000-8000-000000000002', url: 'https://b.com' }),
      { screenshot: false },
    )

    const outcome = await drain()

    expect(outcome.drained).toBe(2)
    expect(files.has('notes/capture-2026-06-11-153022-845-0000.md')).toBe(true)
    expect(files.has('notes/capture-2026-06-11-153022-845-ffff.md')).toBe(true)
  })

  it('saves a capture whose screenshot cannot decode, without wedging the pass', async () => {
    addSpool(envelope())
    promoteMock.mockRejectedValue({ kind: 'parse', message: 'screenshot does not decode' })

    const outcome = await drain()

    // Retrying identical bytes can't help — the capture lands without its
    // image instead of permanently blocking every capture behind it.
    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('![')
    expect(note).not.toContain('captureScreenshot')
    expect(spool.size).toBe(0)
  })

  it('saves a capture whose screenshot sibling never landed, without the image', async () => {
    addSpool(envelope())
    spool.delete('7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg')

    const outcome = await drain()

    expect(outcome.drained).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('![')
    expect(note).not.toContain('captureScreenshot')
  })

  it('sweeps old orphan screenshots but never young ones', async () => {
    spool.set('11111111-1111-4111-8111-111111111111.jpg', { contents: 'x', modifiedMs: 0 })
    spool.set('22222222-2222-4222-8222-222222222222.jpg', {
      contents: 'x',
      modifiedMs: 9_000_000,
    })

    await drain({ now: () => 10_000_000 }) // first is ~2.8h old, second ~17min

    expect(spool.has('11111111-1111-4111-8111-111111111111.jpg')).toBe(false)
    expect(spool.has('22222222-2222-4222-8222-222222222222.jpg')).toBe(true)
  })

  it('stops before any work when the session is stale', async () => {
    addSpool(envelope())
    const outcome = await drain({ isStale: () => true })
    expect(outcome.stopped?.reason).toBe('stale')
    expect(writeNoteMock).not.toHaveBeenCalled()
    expect(spool.size).toBe(2)
  })

  it('a write failure stops the pass with the error kind', async () => {
    addSpool(envelope())
    writeNoteMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await drain()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'disk full' })
    expect(spool.size).toBe(2) // nothing removed — the capture is retryable
  })
})

describe('reconcileCaptureEnrichment', () => {
  async function drainOne(overrides: Partial<CaptureEnvelope> = {}): Promise<void> {
    addSpool(envelope(overrides))
    const outcome = await drain()
    expect(outcome.stopped).toBeNull()
    writeNoteMock.mockClear()
  }

  it('patches the AI description under the link line with provenance', async () => {
    await drainOne({ selection: 'quoted text' })
    scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: 'Example',
    })

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain(
      '[example.com](https://example.com/article)\n\nAn AI description of the page.\n\n> quoted text',
    )
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('captureProvider: openai')
    expect(note).toContain('captureModel: gpt-5.5')
    expect(describeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: URL,
        title: 'An article',
        metaDescription: 'A scraped description.',
        screenshotBase64: btoa('jpeg-bytes'),
      }),
    )
    // Enriched means no longer pending: a second pass finds nothing.
    expect((await reconcile()).pending).toBe(0)
  })

  it('enriches with the scraped description alone when no provider is configured', async () => {
    await drainOne()
    scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: null,
    })

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    expect(describeMock).not.toHaveBeenCalled()
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('stops on a configured provider whose key is missing from the keychain', async () => {
    await drainOne()
    getSecretMock.mockResolvedValue(null)

    const outcome = await reconcile()

    expect(outcome.stopped?.reason).toBe('config')
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: pending')
    expect(scrapeMock).not.toHaveBeenCalled()
  })

  it('skips an edited capture instead of clobbering it — zero outbound', async () => {
    await drainOne()
    const source = files.get(IDENTITY.notePath) ?? ''
    files.set(IDENTITY.notePath, source.replace('# An article', '# My own notes about this'))

    const outcome = await reconcile()

    expect(outcome.skipped).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('captureStatus: skipped')
    expect(note).toContain('# My own notes about this')
    expect(scrapeMock).not.toHaveBeenCalled()
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('skips when the day was marked private after the drain — zero outbound', async () => {
    await drainOne()
    files.set(DAILY, `---\nprivate: true\n---\n\n${files.get(DAILY) ?? ''}`)

    const outcome = await reconcile()

    expect(outcome.skipped).toBe(1)
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(scrapeMock).not.toHaveBeenCalled()
    expect(describeMock).not.toHaveBeenCalled()
    expect(readAssetMock).not.toHaveBeenCalled()
  })

  it('skips when the capture note itself was marked private — zero outbound', async () => {
    await drainOne()
    const source = files.get(IDENTITY.notePath) ?? ''
    files.set(IDENTITY.notePath, source.replace('---\n', '---\nprivate: true\n', ))

    const outcome = await reconcile()

    expect(outcome.skipped).toBe(1)
    expect(scrapeMock).not.toHaveBeenCalled()
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('a transient scrape failure stops the pass; the next pass retries', async () => {
    await drainOne()
    scrapeMock.mockRejectedValueOnce(new ReflectError('network', 'offline'))

    const first = await reconcile()
    expect(first.stopped?.reason).toBe('network')
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: pending')

    const second = await reconcile()
    expect(second.enriched).toBe(1)
  })

  it('a permanent scrape failure enriches without meta tags', async () => {
    await drainOne()
    scrapeMock.mockRejectedValue(new ReflectError('parse', 'not an HTML page'))

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    expect(describeMock).toHaveBeenCalledWith(
      expect.objectContaining({ metaDescription: undefined }),
    )
    expect(files.get(IDENTITY.notePath)).toContain('An AI description of the page.')
  })

  it('a provider refusal falls back to the scraped description, done without AI provenance', async () => {
    await drainOne()
    scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: null,
    })
    describeMock.mockRejectedValue(new DescriptionRejectedError('image too large'))

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
  })

  it('an auth failure from the provider stops the pass', async () => {
    await drainOne()
    describeMock.mockRejectedValue(new ReflectError('auth', 'key rejected'))

    const outcome = await reconcile()

    expect(outcome.stopped?.reason).toBe('auth')
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: pending')
  })

  it('never re-enriches done or skipped captures', async () => {
    await drainOne()
    await reconcile()

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 0, enriched: 0, skipped: 0, stopped: null })
  })
})
