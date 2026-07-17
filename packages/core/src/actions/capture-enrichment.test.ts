import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DescriptionRejectedError } from '../ai/describe-page'
import { ReflectError } from '../errors'
import {
  addSpool,
  CAPTURE_URL,
  DAILY,
  describeMock,
  drain,
  envelope,
  files,
  getSecretMock,
  IDENTITY,
  NO_PROVIDERS,
  readAssetMock,
  reconcile,
  scrapeMock,
  wireCaptureMocks,
  writeNoteMock,
} from './capture-harness'
import type { CaptureEnvelope } from './capture-envelope'

const ensureBacklinkTargetMock = vi.hoisted(() => vi.fn())

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
vi.mock('./backlink-target', () => ({
  ensureBacklinkTarget: ensureBacklinkTargetMock,
}))

beforeEach(() => {
  wireCaptureMocks()
  ensureBacklinkTargetMock.mockResolvedValue('Links')
})

describe('reconcileCaptureEnrichment', () => {
  async function drainOne(overrides: Partial<CaptureEnvelope> = {}): Promise<void> {
    addSpool(envelope(overrides))
    const outcome = await drain()
    expect(outcome.stopped).toBeNull()
    writeNoteMock.mockClear()
  }

  it('patches the AI description into the metadata bullets with provenance', async () => {
    const contentText = [
      'First paragraph.',
      '- Description: A line from the captured article.',
      '## Article heading',
      '## Screenshot',
      'This is an article heading, not the capture image section.',
      'Second paragraph.',
    ].join('\n\n')
    await drainOne({
      selection:
        'quoted text\n\n<!-- reflect-capture-page-text:start -->\n\n## Page Text\n\nnot actual page text',
      contentText,
    })
    scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: 'Example',
    })

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('- Type: #link\n- Description: An AI description of the page.\n\n## Selection')
    expect(note).not.toContain('A scraped description.')
    expect(note).toContain('- Description: A line from the captured article.')
    expect(note).toContain('## Article heading')
    expect(note).toContain('This is an article heading, not the capture image section.')
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('captureProvider: openai')
    expect(note).toContain('captureModel: gpt-5.5')
    expect(describeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: CAPTURE_URL,
        title: 'An article',
        metaTitle: 'An article',
        siteName: 'Example',
        metaDescription: 'A scraped description.',
        contentText,
        screenshotBase64: btoa('jpeg-bytes'),
      }),
    )
    // Enriched means no longer pending: a second pass finds nothing.
    expect((await reconcile()).pending).toBe(0)
  })

  it('replaces the drain-written in-page description in place, never duplicating it', async () => {
    await drainOne({ source: 'ios-share', metaDescription: 'The in-page description.' })

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('- Description: An AI description of the page.')
    expect(note).not.toContain('The in-page description.')
  })

  it('meta-only enrichment keeps a drain-written in-page description (never truncates)', async () => {
    await drainOne({ source: 'ios-share', metaDescription: 'The full in-page description.' })
    scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A shorter scraped description.',
      siteName: null,
    })

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('- Description: The full in-page description.')
    expect(note).not.toContain('A shorter scraped description.')
    expect(note).toContain('captureStatus: done')
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
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    expect(describeMock).not.toHaveBeenCalled()
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty title', ''],
    ['a host-equivalent title', 'example.com'],
  ])('retitles a URL-only iOS share with %s from scraped metadata', async (_label, title) => {
    addSpool(envelope({ source: 'ios-share', title }), { screenshot: false })
    expect((await drain()).stopped).toBeNull()
    writeNoteMock.mockClear()
    scrapeMock.mockResolvedValue({
      title: 'An article from its metadata',
      description: 'A scraped description.',
      siteName: 'Example',
    })

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# An article from its metadata')
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain(
      '- [[capture-2026-06-11-153022-845-7c9e|An article from its metadata]]',
    )
    expect(daily).not.toContain('|example.com]]')
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('keeps a supplied capture title when scraped metadata differs', async () => {
    await drainOne({ source: 'ios-share', title: 'The title supplied by the app' })
    scrapeMock.mockResolvedValue({
      title: 'A different metadata title',
      description: 'A scraped description.',
      siteName: 'Example',
    })

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    expect(files.get(IDENTITY.notePath)).toContain('# The title supplied by the app')
    expect(files.get(DAILY)).toContain('|The title supplied by the app]]')
    expect(files.get(DAILY)).not.toContain('|A different metadata title]]')
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
    expect(files.get(IDENTITY.notePath)).toContain('- Description: An AI description of the page.')
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
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
  })

  it('a provider refusal without scraped description does not stamp AI provenance', async () => {
    await drainOne()
    scrapeMock.mockResolvedValue({ title: 'An article', description: null, siteName: null })
    describeMock.mockRejectedValue(new DescriptionRejectedError('image too large'))

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('- Description:')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    expect(note).not.toContain('captureModel')
  })

  it('omits the description bullet when no description source exists', async () => {
    await drainOne()
    scrapeMock.mockResolvedValue({ title: 'An article', description: null, siteName: null })

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('- Description:')
    expect(note).toContain('captureStatus: done')
  })

  it('an auth failure from the provider stops the pass', async () => {
    await drainOne()
    describeMock.mockRejectedValue(new ReflectError('auth', 'key rejected'))

    const outcome = await reconcile()

    expect(outcome.stopped?.reason).toBe('auth')
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: pending')
  })

  it('retitles the note H1, screenshot alt, and daily link text from the AI title', async () => {
    await drainOne()
    describeMock.mockResolvedValue({
      title: 'A Cleaned Up Article',
      description: 'An AI description of the page.',
    })

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A Cleaned Up Article')
    expect(note).not.toContain('# An article')
    expect(note).toContain(`![A Cleaned Up Article](${IDENTITY.assetPath})`)
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('captureProvider: openai')
    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain('- [[capture-2026-06-11-153022-845-7c9e|A Cleaned Up Article]]')
    expect(daily).not.toContain('|An article]]')
  })

  it('keeps the captured title when the AI answer matches it — the daily is never rewritten', async () => {
    await drainOne()
    describeMock.mockResolvedValue({
      title: 'An article',
      description: 'An AI description of the page.',
    })

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    expect(files.get(IDENTITY.notePath)).toContain('# An article')
    expect(writeNoteMock.mock.calls.filter(([path]) => path === DAILY)).toHaveLength(0)
  })

  it('keeps the captured title when the model produced no usable one', async () => {
    await drainOne()

    await reconcile()

    expect(files.get(IDENTITY.notePath)).toContain('# An article')
    expect(files.get(DAILY)).toContain('|An article]]')
    expect(writeNoteMock.mock.calls.filter(([path]) => path === DAILY)).toHaveLength(0)
  })

  it('preserves daily edits made while the provider call was in flight', async () => {
    await drainOne()
    describeMock.mockImplementation(async () => {
      files.set(DAILY, `${files.get(DAILY) ?? ''}\n- jotted down mid-enrichment\n`)
      return { title: 'A Cleaned Up Article', description: 'An AI description of the page.' }
    })

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain('- jotted down mid-enrichment')
    expect(daily).toContain('|A Cleaned Up Article]]')
  })

  it('leaves a user-edited daily link text alone while still retitling the note', async () => {
    await drainOne()
    files.set(DAILY, (files.get(DAILY) ?? '').replace('|An article]]', '|my own link text]]'))
    describeMock.mockResolvedValue({
      title: 'A Cleaned Up Article',
      description: 'An AI description of the page.',
    })

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    expect(files.get(IDENTITY.notePath)).toContain('# A Cleaned Up Article')
    expect(files.get(DAILY)).toContain('|my own link text]]')
  })

  it('an AI title with a blank description retitles, stamps provenance, and keeps the scraped description', async () => {
    await drainOne()
    scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: null,
    })
    describeMock.mockResolvedValue({ title: 'A Cleaned Up Article', description: '' })

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A Cleaned Up Article')
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureProvider: openai')
    expect(note).toContain('captureModel: gpt-5.5')
  })

  it('never re-enriches done or skipped captures', async () => {
    await drainOne()
    await reconcile()

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 0, enriched: 0, skipped: 0, stopped: null })
  })
})
