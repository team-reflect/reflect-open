import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors'
import { captureJsonFetch, createNoteIfAbsent } from '../graph/commands'
import { dailyPath } from '../graph/paths'
import { parseNote } from '../markdown/extract'
import { splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import { addSpool, DAILY, describeMock, drain, envelope, files, getSecretMock, inboxRemoveMock, linkPreviewMock, NO_PROVIDERS, promoteMock, readNoteMock, reconcile, scrapeMock, spool, wireCaptureMocks, writeNoteMock } from './capture-harness'
import { listPendingCaptures } from './capture-enrichment'
import { persistCaptureEnrichment } from './capture-enrichment-write'
import { xCaptureIdentity, xCaptureMeta } from './x-capture-note'
import { xPostURL } from './x-post'

vi.mock('../graph/commands', () => ({
  captureInboxList: vi.fn(), captureInboxRead: vi.fn(), captureInboxReject: vi.fn(),
  captureInboxRemove: vi.fn(), captureLinkPreview: vi.fn(), captureJsonFetch: vi.fn(),
  createNoteIfAbsent: vi.fn(), listFiles: vi.fn(), promoteCaptureScreenshot: vi.fn(),
  readAsset: vi.fn(), readNote: vi.fn(), writeAsset: vi.fn(), writeNote: vi.fn(),
}))
vi.mock('./meta-scrape', () => ({ scrapePageMeta: vi.fn() }))
vi.mock('../ai/describe-page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/describe-page')>()), describePage: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({ getSecret: vi.fn() }))
vi.mock('./backlink-target', () => ({ ensureBacklinkTarget: vi.fn(async () => 'Links') }))

const POST_ID = '1234567890123456789'
const CAPTURE = envelope({ url: xPostURL(POST_ID), title: `X post ${POST_ID}` })
const IDENTITY = xCaptureIdentity(CAPTURE.id, '2026-06-11')
const fetchMock = vi.mocked(captureJsonFetch)
const createMock = vi.mocked(createNoteIfAbsent)
const ANSWER = JSON.stringify({ id_str: POST_ID, text: 'Public post text.', user: { name: 'Example', screen_name: 'example' } })

function source(): string {
  const value = files.get(IDENTITY.notePath)
  if (value === undefined) throw new Error('capture was not saved')
  return value
}

function body(): string {
  return splitFrontmatter(source()).body
}

beforeEach(() => {
  wireCaptureMocks()
  fetchMock.mockReset().mockResolvedValue(ANSWER)
  createMock.mockReset().mockImplementation(async (path, contents) => {
    if (files.has(path)) return { kind: 'collision' }
    files.set(path, contents)
    return { kind: 'created', modifiedMs: 0 }
  })
})

describe('X capture create and replay', () => {
  it('preserves manual input and skips all enrichment when page text is supplied', async () => {
    const annotation = '## Page Text\n\n<!-- reflect-capture-page-text:end -->\n\n[[My note]]'
    const external = '![remote](https://example.com/image.png) <img src="https://example.com/x"> [[external]]'
    addSpool({ ...CAPTURE, note: annotation, selection: external, contentText: external })
    expect((await drain()).drained).toBe(1)
    expect(source()).toContain(annotation)
    const parsed = parseNote({ path: IDENTITY.notePath, source: source() })
    expect(parsed.wikiLinks.map((link) => link.target)).toEqual(['My note'])
    expect(parsed.assets.map((asset) => asset.path)).toEqual([IDENTITY.assetPath])
    expect(parsed.links.map((link) => link.href)).not.toContain('https://example.com/image.png')
    expect(xCaptureMeta(source()).captureStatus).toBe('done')
    await reconcile()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(scrapeMock).not.toHaveBeenCalled()
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('repairs the Daily after failure without rebuilding the edited winner', async () => {
    addSpool({ ...CAPTURE, note: 'First annotation' })
    writeNoteMock.mockRejectedValueOnce(new ReflectError('io', 'disk full'))
    expect((await drain()).stopped?.reason).toBe('io')
    const edited = source() + '\n## User section\n\nKeep me.\n'
    files.set(IDENTITY.notePath, edited)
    expect((await drain()).drained).toBe(1)
    expect(source()).toBe(edited)
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(promoteMock).toHaveBeenCalledTimes(1)
    expect(spool.size).toBe(0)
    expect(parseNote({ path: DAILY, source: files.get(DAILY) ?? '' }).wikiLinks.filter((link) => link.target === IDENTITY.base)).toHaveLength(1)
  })

  it('replays after screenshot cleanup without needing the deleted screenshot', async () => {
    addSpool(CAPTURE)
    inboxRemoveMock.mockImplementationOnce(async (name) => { spool.delete(name) })
      .mockRejectedValueOnce(new ReflectError('io', 'cannot remove JSON'))
    expect((await drain()).stopped?.reason).toBe('io')
    const saved = source()
    expect(spool.has(`${CAPTURE.id}.jpg`)).toBe(false)
    expect((await drain()).drained).toBe(1)
    expect(source()).toBe(saved)
    expect(promoteMock).toHaveBeenCalledTimes(1)
    expect(spool.size).toBe(0)
  })

  it('uses the persisted day on replay and pending discovery', async () => {
    addSpool(CAPTURE, { screenshot: false })
    await drain()
    files.set(IDENTITY.notePath, upsertFrontmatter(source(), { captureDay: '2026-06-10' }))
    addSpool({ ...CAPTURE, capturedAt: '2026-06-12T23:59:59-10:00' }, { screenshot: false })
    expect((await drain()).drained).toBe(1)
    expect(files.get(dailyPath('2026-06-10'))).toContain(IDENTITY.base)
    expect((await listPendingCaptures(3))[0]?.date).toBe('2026-06-10')
  })

  it('creates separate notes for distinct UUIDs of the same URL', async () => {
    addSpool(CAPTURE, { screenshot: false })
    addSpool({ ...CAPTURE, id: '7c9e6679-7425-40de-944b-e07fc1f90ae8' }, { screenshot: false })
    expect((await drain()).drained).toBe(2)
    expect([...files.keys()].filter((path) => path.startsWith('notes/capture-x-text-'))).toHaveLength(2)
  })

  it('keeps the spool when an unrelated file occupies the UUID path', async () => {
    files.set(IDENTITY.notePath, '# My existing note\n')
    addSpool(CAPTURE)
    expect((await drain()).stopped?.reason).toBe('parse')
    expect(source()).toBe('# My existing note\n')
    expect(spool.size).toBe(2)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('adopts an atomic create winner rather than overwriting it', async () => {
    addSpool(CAPTURE, { screenshot: false })
    createMock.mockImplementationOnce(async (path, contents) => {
      files.set(path, contents + '\nWinner annotation\n')
      return { kind: 'collision' }
    })
    expect((await drain()).drained).toBe(1)
    expect(source()).toContain('Winner annotation')
  })

  it('defers a dirty Daily and inherits private on initial creation', async () => {
    addSpool(CAPTURE, { screenshot: false })
    expect((await drain({ isNoteDirty: (path) => path === DAILY })).drained).toBe(0)
    expect(createMock).not.toHaveBeenCalled()
    files.set(DAILY, '---\nprivate: true\n---\n# Daily\n')
    await drain()
    expect(source()).toContain('private: true')
    expect(xCaptureMeta(source()).captureStatus).toBe('skipped')
    await reconcile()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('X text enrichment', () => {
  beforeEach(async () => {
    addSpool(CAPTURE, { screenshot: false })
    expect((await drain()).stopped).toBeNull()
    writeNoteMock.mockClear()
  })

  it('commits the appended text and terminal status once, without AI or retitle', async () => {
    const raw = body()
    const daily = files.get(DAILY)
    files.set(IDENTITY.notePath, upsertFrontmatter(source(), { custom: 'preserved' }))
    expect((await reconcile({ providers: NO_PROVIDERS })).enriched).toBe(1)
    expect(body().startsWith(raw)).toBe(true)
    expect(body()).toContain('Public post text\\.')
    expect(source()).toContain('custom: preserved')
    expect(xCaptureMeta(source()).captureStatus).toBe('done')
    expect(writeNoteMock).toHaveBeenCalledTimes(1)
    expect(files.get(DAILY)).toBe(daily)
    const done = source()
    await reconcile()
    expect(source()).toBe(done)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getSecretMock).not.toHaveBeenCalled()
    expect(describeMock).not.toHaveBeenCalled()
    expect(linkPreviewMock).not.toHaveBeenCalled()
    expect(scrapeMock).not.toHaveBeenCalled()
  })

  it.each(['notFound', 'parse'] as const)('finishes unavailable %s responses', async (kind) => {
    fetchMock.mockRejectedValueOnce(new ReflectError(kind, 'unavailable'))
    expect((await reconcile()).enriched).toBe(1)
    expect(body()).toContain('No public text was available.')
    expect(xCaptureMeta(source()).captureStatus).toBe('done')
  })

  it.each(['network', 'io'] as const)('keeps %s errors pending', async (kind) => {
    const raw = source()
    fetchMock.mockRejectedValueOnce(new ReflectError(kind, 'failed'))
    expect((await reconcile()).stopped?.reason).toBe(kind)
    expect(source()).toBe(raw)
    expect((await reconcile()).enriched).toBe(1)
  })

  it('does not mistake a disk failure for unavailable text', async () => {
    const raw = source()
    writeNoteMock.mockRejectedValueOnce(new ReflectError('io', 'disk full'))
    expect((await reconcile()).stopped?.reason).toBe('io')
    expect(source()).toBe(raw)
    expect((await reconcile()).enriched).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['body', 'url', 'day', 'note-private', 'daily-private', 'note-dirty', 'daily-dirty', 'stale'] as const)(
    'does not append when %s changes during fetch', async (change) => {
      const response = Promise.withResolvers<string>()
      const started = Promise.withResolvers<void>()
      fetchMock.mockImplementationOnce(() => { started.resolve(); return response.promise })
      let dirty = ''
      let stale = false
      const raw = body()
      const running = reconcile({ isNoteDirty: (path) => path === dirty, isStale: () => stale })
      await started.promise
      if (change === 'body') files.set(IDENTITY.notePath, source() + '\nKeep edit\n')
      if (change === 'url') files.set(IDENTITY.notePath, upsertFrontmatter(source(), { captureUrl: xPostURL('42') }))
      if (change === 'day') files.set(IDENTITY.notePath, upsertFrontmatter(source(), { captureDay: '2026-06-10' }))
      if (change === 'note-private') files.set(IDENTITY.notePath, upsertFrontmatter(source(), { private: true }))
      if (change === 'daily-private') files.set(DAILY, upsertFrontmatter(files.get(DAILY) ?? '', { private: true }))
      if (change === 'note-dirty') dirty = IDENTITY.notePath
      if (change === 'daily-dirty') dirty = DAILY
      if (change === 'stale') stale = true
      response.resolve(ANSWER)
      await running
      expect(body()).toBe(change === 'body' ? raw + '\nKeep edit\n' : raw)
      expect(xCaptureMeta(source()).captureStatus).toBe(dirty || stale ? 'pending' : 'skipped')
    },
  )

  it('checks dirty again in the final writer', async () => {
    let dirty = false
    const original = readNoteMock.getMockImplementation()
    if (!original) throw new Error('read mock not initialized')
    readNoteMock.mockImplementation(async (path, generation) => {
      const contents = await original(path, generation)
      if (path === DAILY) dirty = true
      return contents
    })
    const meta = xCaptureMeta(source())
    const title = `X post ${POST_ID}`
    expect(await persistCaptureEnrichment({
      identity: IDENTITY, expectedHash: meta.captureHash, expectedCapture: meta,
      body: body() + '\nDo not append\n', fromTitle: title, toTitle: title,
      status: 'done', provider: null, generation: 3, canWrite: () => !dirty,
    })).toBeNull()
    expect(writeNoteMock).not.toHaveBeenCalled()
    expect(xCaptureMeta(source()).captureStatus).toBe('pending')
  })

  it.each(['---\nprivate: [\n---\n', '---\nprivate: true\n'])(
    'refuses malformed Daily frontmatter before fetching', async (daily) => {
      files.set(DAILY, daily)
      expect((await reconcile()).stopped?.reason).toBe('parse')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})
