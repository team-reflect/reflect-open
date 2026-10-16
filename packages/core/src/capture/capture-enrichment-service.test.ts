import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureEnvelope } from './capture-envelope.ts'
import { captureIdentity } from './capture-identity.ts'
import { DescriptionRejectedError } from '../ai/page-describer-service.ts'
import { ReflectError } from '../errors.ts'
import {
  API_KEY_SECRET,
  CAPTURE_URL,
  createCaptureTestKit,
  DAILY,
  envelope,
  IDENTITY,
  NO_PROVIDERS,
  type CaptureTestKit,
} from './capture-test-kit.ts'

let kit: CaptureTestKit

beforeEach(() => {
  kit = createCaptureTestKit()
})

describe('CaptureEnrichmentService', () => {
  async function drainOne(overrides: Partial<CaptureEnvelope> = {}): Promise<void> {
    kit.addSpool(envelope(overrides))
    const outcome = await kit.drain()
    expect(outcome.stopped).toBeNull()
    kit.writeNoteMock.mockClear()
  }

  it('attaches an Apple link preview to a URL-only capture', async () => {
    kit.addSpool(envelope({ source: 'ios-share', title: '' }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.linkPreviewMock.mockResolvedValue(btoa('preview-jpeg'))
    kit.scrapeMock.mockResolvedValue({
      title: 'An article from metadata',
      description: 'A scraped description.',
      siteName: null,
    })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    expect(kit.linkPreviewMock).toHaveBeenCalledWith(CAPTURE_URL)
    expect(kit.writeAssetMock).toHaveBeenCalledWith(IDENTITY.assetPath, btoa('preview-jpeg'), 3)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain(`captureScreenshot: ${IDENTITY.assetPath}`)
    expect(note).toContain(`![An article from metadata](${IDENTITY.assetPath})`)
    expect(note).toContain('captureStatus: done')
  })

  it('sends a newly attached link preview to the configured AI provider', async () => {
    kit.addSpool(envelope({ source: 'ios-share' }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.linkPreviewMock.mockResolvedValue(btoa('preview-jpeg'))

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    expect(kit.readAssetMock).toHaveBeenCalledWith(IDENTITY.assetPath, 3)
    expect(kit.describeMock).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotBase64: btoa('jpeg-bytes') }),
    )
  })

  it('does not request a link preview when the capture already has a screenshot', async () => {
    await drainOne()

    await kit.reconcile()

    expect(kit.linkPreviewMock).not.toHaveBeenCalled()
  })

  it('treats an empty screenshot stamp as missing', async () => {
    kit.addSpool(envelope({ source: 'ios-share' }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    const source = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    kit.noteFile.set(
      IDENTITY.notePath,
      source.replace('captureStatus: pending\n', "captureStatus: pending\ncaptureScreenshot: ''\n"),
    )
    kit.writeNoteMock.mockClear()
    kit.linkPreviewMock.mockResolvedValue(btoa('preview-jpeg'))

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    expect(kit.linkPreviewMock).toHaveBeenCalledWith(CAPTURE_URL)
    expect(kit.writeAssetMock).toHaveBeenCalledWith(IDENTITY.assetPath, btoa('preview-jpeg'), 3)
  })

  it('continues metadata enrichment when the link preview request fails', async () => {
    kit.addSpool(envelope({ source: 'ios-share' }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.linkPreviewMock.mockRejectedValue(new ReflectError('network', 'preview unavailable'))

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureScreenshot')
    expect(note).not.toContain('## Screenshot')
  })

  it('does not retry a link preview after the metadata checkpoint', async () => {
    kit.addSpool(envelope({ source: 'ios-share' }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.linkPreviewMock.mockResolvedValue(btoa('preview-jpeg'))
    kit.installSecrets()

    const waiting = await kit.reconcile()

    expect(waiting.stopped?.reason).toBe('config')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureMetadataStatus: done')
    expect(kit.linkPreviewMock).toHaveBeenCalledTimes(1)

    kit.installSecrets({ [API_KEY_SECRET]: 'sk-live-key' })
    const retry = await kit.reconcile()

    expect(retry.enriched).toBe(1)
    expect(kit.linkPreviewMock).toHaveBeenCalledTimes(1)
  })

  it('skips a capture made private while its link preview is loading', async () => {
    kit.addSpool(envelope({ source: 'ios-share' }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.linkPreviewMock.mockImplementation(async () => {
      kit.noteFile.set(DAILY, `---\nprivate: true\n---\n\n${kit.noteFile.files().get(DAILY) ?? ''}`)
      return btoa('preview-jpeg')
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 0, skipped: 1, stopped: null })
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(kit.writeAssetMock).not.toHaveBeenCalled()
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

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
    kit.scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: 'Example',
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain(
      '- Type: #link\n- Description: An AI description of the page.\n\n## Selection',
    )
    expect(note).not.toContain('A scraped description.')
    expect(note).toContain('- Description: A line from the captured article.')
    expect(note).toContain('## Article heading')
    expect(note).toContain('This is an article heading, not the capture image section.')
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('captureProvider: openai')
    expect(note).toContain('captureModel: gpt-5.5')
    expect(kit.describeMock).toHaveBeenCalledWith(
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
    expect((await kit.reconcile()).pending).toBe(0)
  })

  it('replaces the drain-written in-page description in place, never duplicating it', async () => {
    await drainOne({ source: 'ios-share', metaDescription: 'The in-page description.' })

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('- Description: An AI description of the page.')
    expect(note).not.toContain('The in-page description.')
  })

  it('meta-only enrichment keeps a drain-written in-page description (never truncates)', async () => {
    await drainOne({ source: 'ios-share', metaDescription: 'The full in-page description.' })
    kit.scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A shorter scraped description.',
      siteName: null,
    })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('- Description: The full in-page description.')
    expect(note).not.toContain('A shorter scraped description.')
    expect(note).toContain('captureStatus: done')
  })

  it('enriches with the scraped description alone when no provider is configured', async () => {
    await drainOne()
    kit.scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: null,
    })

    const getSecret = vi.spyOn(kit.installSecrets({ [API_KEY_SECRET]: 'sk-live-key' }), 'get')

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    expect(kit.describeMock).not.toHaveBeenCalled()
    expect(getSecret).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty title', ''],
    ['a host-equivalent title', 'example.com'],
  ])('retitles a URL-only iOS share with %s from scraped metadata', async (_label, title) => {
    kit.addSpool(envelope({ source: 'ios-share', title }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.scrapeMock.mockResolvedValue({
      title: 'An article from its metadata',
      description: 'A scraped description.',
      siteName: 'Example',
    })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# An article from its metadata')
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily).toContain('- [[capture-2026-06-11-153022-845-7c9e|An article from its metadata]]')
    expect(daily).not.toContain('|example.com]]')
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('clips a runaway scraped title at a word boundary', async () => {
    kit.addSpool(envelope({ source: 'ios-share', title: '' }), { screenshot: false })
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.scrapeMock.mockResolvedValue({
      title: `${'lengthy '.repeat(20)}tail`,
      description: 'A scraped description.',
      siteName: 'Instagram',
    })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    const heading = note.split('\n').find((line) => line.startsWith('# '))
    expect(heading).toBeDefined()
    expect(heading!.length).toBeLessThanOrEqual('# '.length + 100)
    expect(heading).not.toContain('tail')
    expect(kit.noteFile.files().get(DAILY)).toContain(`|${heading!.slice('# '.length)}]]`)
  })

  it('keeps a supplied capture title when scraped metadata differs', async () => {
    await drainOne({ source: 'ios-share', title: 'The title supplied by the app' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A different metadata title',
      description: 'A scraped description.',
      siteName: 'Example',
    })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('# The title supplied by the app')
    expect(kit.noteFile.files().get(DAILY)).toContain('|The title supplied by the app]]')
    expect(kit.noteFile.files().get(DAILY)).not.toContain('|A different metadata title]]')
  })

  it('persists scraped metadata before waiting for AI enrichment', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A title available immediately',
      description: 'A description available immediately.',
      siteName: null,
    })
    let finishProvider: (() => void) | undefined
    kit.describeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProvider = () =>
            resolve({ title: 'A title from AI', description: 'A description from AI.' })
        }),
    )

    const running = kit.reconcile()

    await vi.waitFor(() => {
      const pendingNote = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
      expect(pendingNote).toContain('# A title available immediately')
      expect(pendingNote).toContain('- Description: A description available immediately.')
      expect(pendingNote).toContain(`![A title available immediately](${IDENTITY.assetPath})`)
      expect(pendingNote).toContain('captureStatus: pending')
      expect(kit.noteFile.files().get(DAILY)).toContain('|A title available immediately]]')
      expect(kit.describeMock).toHaveBeenCalledTimes(1)
    })

    if (finishProvider === undefined) {
      throw new Error('provider did not start')
    }
    finishProvider()
    expect(await running).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const enrichedNote = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(enrichedNote).toContain('# A title from AI')
    expect(enrichedNote).toContain('- Description: A description from AI.')
    expect(enrichedNote).toContain('captureStatus: done')
    expect(kit.noteFile.files().get(DAILY)).toContain('|A title from AI]]')
  })

  it('applies scraped metadata while waiting for a configured provider key', async () => {
    kit.addSpool(
      envelope({
        source: 'ios-share',
        url: 'https://www.instagram.com/reel/example/',
        title: '',
      }),
      { screenshot: false },
    )
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.scrapeMock.mockResolvedValue({
      title: 'First Chair on Instagram',
      description: 'An Instagram reel about furniture and decor.',
      siteName: 'Instagram',
    })
    kit.installSecrets()

    const outcome = await kit.reconcile()

    expect(outcome.stopped?.reason).toBe('config')
    const pendingNote = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(pendingNote).toContain('# First Chair on Instagram')
    expect(pendingNote).toContain('- Description: An Instagram reel about furniture and decor.')
    expect(pendingNote).toContain('captureStatus: pending')
    expect(pendingNote).toContain('captureMetadataStatus: done')
    expect(pendingNote).not.toContain('captureProvider')
    expect(kit.noteFile.files().get(DAILY)).toContain('|First Chair on Instagram]]')
    expect(kit.describeMock).not.toHaveBeenCalled()

    kit.scrapeMock.mockClear()
    const stillWaiting = await kit.reconcile()

    expect(stillWaiting).toEqual({
      pending: 1,
      enriched: 0,
      skipped: 0,
      stopped: expect.objectContaining({ reason: 'config' }),
    })
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).not.toHaveBeenCalled()

    kit.installSecrets({ [API_KEY_SECRET]: 'sk-live-key' })
    const retry = await kit.reconcile()

    expect(retry).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const enrichedNote = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(enrichedNote).toContain('# First Chair on Instagram')
    expect(enrichedNote).toContain('- Description: An AI description of the page.')
    expect(enrichedNote).toContain('captureStatus: done')
    expect(enrichedNote).toContain('captureProvider: openai')
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'First Chair on Instagram',
        metaTitle: 'First Chair on Instagram',
        metaDescription: 'An Instagram reel about furniture and decor.',
      }),
    )
  })

  it('applies scraped metadata while preserving a keychain failure', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A title available without the keychain',
      description: 'A description available without the keychain.',
      siteName: null,
    })
    kit.installFailingSecrets(new ReflectError('io', 'keychain is unavailable'))

    const outcome = await kit.reconcile()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'keychain is unavailable' })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A title available without the keychain')
    expect(note).toContain('- Description: A description available without the keychain.')
    expect(note).toContain('captureStatus: pending')
    expect(note).toContain('captureMetadataStatus: done')
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('skips an edited capture instead of clobbering it — zero outbound', async () => {
    await drainOne()
    const source = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    kit.noteFile.set(IDENTITY.notePath, source.replace('# An article', '# My own notes about this'))

    const outcome = await kit.reconcile()

    expect(outcome.skipped).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('captureStatus: skipped')
    expect(note).toContain('# My own notes about this')
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('skips when the day was marked private after the drain — zero outbound', async () => {
    await drainOne()
    kit.noteFile.set(DAILY, `---\nprivate: true\n---\n\n${kit.noteFile.files().get(DAILY) ?? ''}`)

    const outcome = await kit.reconcile()

    expect(outcome.skipped).toBe(1)
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).not.toHaveBeenCalled()
    expect(kit.readAssetMock).not.toHaveBeenCalled()
  })

  it('skips when the capture note itself was marked private — zero outbound', async () => {
    await drainOne()
    const source = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    kit.noteFile.set(IDENTITY.notePath, source.replace('---\n', '---\nprivate: true\n'))

    const outcome = await kit.reconcile()

    expect(outcome.skipped).toBe(1)
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('preserves capture edits made while metadata is being fetched', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockImplementation(async () => {
      const source = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
      kit.noteFile.set(IDENTITY.notePath, source.replace('# example.com', '# My edited title'))
      return {
        title: 'A scraped title',
        description: 'A scraped description.',
        siteName: null,
      }
    })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({ pending: 1, enriched: 0, skipped: 1, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# My edited title')
    expect(note).not.toContain('A scraped description.')
    expect(note).toContain('captureStatus: skipped')
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('does not send capture content to AI when the day becomes private during metadata fetch', async () => {
    await drainOne()
    kit.scrapeMock.mockImplementation(async () => {
      kit.noteFile.set(DAILY, `---\nprivate: true\n---\n\n${kit.noteFile.files().get(DAILY) ?? ''}`)
      return {
        title: 'An article',
        description: 'A scraped description.',
        siteName: null,
      }
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 0, skipped: 1, stopped: null })
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(kit.describeMock).not.toHaveBeenCalled()
    expect(kit.readAssetMock).not.toHaveBeenCalled()
  })

  it('does not send capture content to AI when the day becomes private while loading its screenshot', async () => {
    await drainOne()
    kit.readAssetMock.mockImplementation(async () => {
      kit.noteFile.set(DAILY, `---\nprivate: true\n---\n\n${kit.noteFile.files().get(DAILY) ?? ''}`)
      return btoa('jpeg-bytes')
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 0, skipped: 1, stopped: null })
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(kit.readAssetMock).toHaveBeenCalledTimes(1)
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('does not resurrect a capture deleted during metadata fetch', async () => {
    await drainOne()
    kit.scrapeMock.mockImplementation(async () => {
      await kit.noteFile.delete(IDENTITY.notePath, 3)
      return {
        title: 'An article',
        description: 'A scraped description.',
        siteName: null,
      }
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 0, skipped: 0, stopped: null })
    expect(kit.noteFile.files().has(IDENTITY.notePath)).toBe(false)
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('a transient scrape failure leaves the capture pending; the next pass retries', async () => {
    await drainOne()
    kit.scrapeMock.mockRejectedValueOnce(new ReflectError('network', 'offline'))

    const first = await kit.reconcile()
    expect(first.stopped?.reason).toBe('network')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: pending')

    const second = await kit.reconcile()
    expect(second.enriched).toBe(1)
  })

  it('a rate-limited page leaves its capture pending without starving the queue', async () => {
    const laterAt = new Date(2026, 5, 11, 16, 0, 0, 0)
    const laterId = '9d0f7780-8536-4a1e-a55c-f18fd2a01bf8'
    const laterIdentity = captureIdentity(laterAt, laterId)
    kit.addSpool(
      envelope({ source: 'ios-share', url: 'https://www.instagram.com/reel/example/', title: '' }),
      { screenshot: false },
    )
    kit.addSpool(
      envelope({ id: laterId, capturedAt: laterAt.toISOString(), title: 'An article' }),
      {
        screenshot: false,
      },
    )
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.scrapeMock.mockImplementation(async (url) => {
      if (url.includes('instagram')) {
        throw new ReflectError('network', 'https://www.instagram.com answered 429')
      }
      return { title: 'An article', description: 'A scraped description.', siteName: null }
    })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({
      pending: 2,
      enriched: 1,
      skipped: 0,
      stopped: expect.objectContaining({ reason: 'network' }),
    })
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: pending')
    expect(kit.noteFile.files().get(laterIdentity.notePath)).toContain('captureStatus: done')
    expect(kit.noteFile.files().get(laterIdentity.notePath)).toContain(
      '- Description: A scraped description.',
    )

    kit.scrapeMock.mockResolvedValue({
      title: 'First Chair on Instagram',
      description: 'An Instagram reel about furniture and decor.',
      siteName: 'Instagram',
    })
    const retry = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(retry).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('# First Chair on Instagram')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: done')
  })

  it('a keychain failure outranks a transient stop — the toast is never masked', async () => {
    const laterAt = new Date(2026, 5, 11, 16, 0, 0, 0)
    const laterId = '9d0f7780-8536-4a1e-a55c-f18fd2a01bf8'
    kit.addSpool(envelope({ url: 'https://www.instagram.com/reel/example/', title: '' }), {
      screenshot: false,
    })
    kit.addSpool(
      envelope({ id: laterId, capturedAt: laterAt.toISOString(), title: 'An article' }),
      {
        screenshot: false,
      },
    )
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.scrapeMock.mockImplementation(async (url) => {
      if (url.includes('instagram')) {
        throw new ReflectError('network', 'https://www.instagram.com answered 429')
      }
      return { title: 'An article', description: 'A scraped description.', siteName: null }
    })
    kit.installFailingSecrets(new ReflectError('io', 'keychain is unavailable'))

    const outcome = await kit.reconcile()

    expect(kit.scrapeMock).toHaveBeenCalledTimes(2)
    expect(kit.scrapeMock).toHaveBeenNthCalledWith(1, expect.stringContaining('instagram'))
    expect(kit.scrapeMock.mock.calls[1]?.[0]).not.toContain('instagram')
    expect(outcome.stopped).toEqual({ reason: 'io', message: 'keychain is unavailable' })
    expect(outcome.pending).toBe(2)
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('a rate-limited provider leaves its capture pending without starving the queue', async () => {
    const laterAt = new Date(2026, 5, 11, 16, 0, 0, 0)
    const laterId = '9d0f7780-8536-4a1e-a55c-f18fd2a01bf8'
    const laterIdentity = captureIdentity(laterAt, laterId)
    kit.addSpool(envelope({ url: 'https://example.com/first', title: 'The first article' }), {
      screenshot: false,
    })
    kit.addSpool(
      envelope({
        id: laterId,
        capturedAt: laterAt.toISOString(),
        url: 'https://example.com/second',
        title: 'The second article',
      }),
      { screenshot: false },
    )
    expect((await kit.drain()).stopped).toBeNull()
    kit.writeNoteMock.mockClear()
    kit.describeMock.mockImplementation(async (request) => {
      if (request.url.endsWith('/first')) {
        throw new ReflectError('network', 'the provider is unavailable (429)')
      }
      return { title: null, description: 'An AI description of the page.' }
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({
      pending: 2,
      enriched: 1,
      skipped: 0,
      stopped: expect.objectContaining({ reason: 'network' }),
    })
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: pending')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureMetadataStatus: done')
    expect(kit.noteFile.files().get(laterIdentity.notePath)).toContain('captureStatus: done')
    expect(kit.noteFile.files().get(laterIdentity.notePath)).toContain(
      '- Description: An AI description of the page.',
    )
  })

  it('a permanent scrape failure enriches without meta tags', async () => {
    await drainOne()
    kit.scrapeMock.mockRejectedValue(new ReflectError('parse', 'not an HTML page'))

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    expect(kit.describeMock).toHaveBeenCalledWith(
      expect.objectContaining({ metaDescription: undefined }),
    )
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain(
      '- Description: An AI description of the page.',
    )
  })

  it('a provider refusal falls back to scraped metadata, done without AI provenance', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A title from metadata',
      description: 'A scraped description.',
      siteName: null,
    })
    kit.describeMock.mockRejectedValue(new DescriptionRejectedError('image too large'))

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A title from metadata')
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    expect(kit.noteFile.files().get(DAILY)).toContain('|A title from metadata]]')
  })

  it('a provider refusal without scraped description does not stamp AI provenance', async () => {
    await drainOne()
    kit.scrapeMock.mockResolvedValue({ title: 'An article', description: null, siteName: null })
    kit.describeMock.mockRejectedValue(new DescriptionRejectedError('image too large'))

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('- Description:')
    expect(note).toContain('captureStatus: done')
    expect(note).not.toContain('captureProvider')
    expect(note).not.toContain('captureModel')
  })

  it('omits the description bullet when no description source exists', async () => {
    await drainOne()
    kit.scrapeMock.mockResolvedValue({ title: 'An article', description: null, siteName: null })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('- Description:')
    expect(note).toContain('captureStatus: done')
  })

  it('an auth failure from the provider stops the pass', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A title available without AI',
      description: 'A description available without AI.',
      siteName: null,
    })
    kit.describeMock.mockRejectedValue(new ReflectError('auth', 'key rejected'))

    const outcome = await kit.reconcile()

    expect(outcome.stopped?.reason).toBe('auth')
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A title available without AI')
    expect(note).toContain('- Description: A description available without AI.')
    expect(note).toContain('captureStatus: pending')
    expect(note).not.toContain('captureProvider')
    expect(kit.noteFile.files().get(DAILY)).toContain('|A title available without AI]]')

    kit.scrapeMock.mockClear()
    kit.scrapeMock.mockRejectedValue(new ReflectError('network', 'offline'))
    kit.describeMock.mockResolvedValue({
      title: null,
      description: 'A description from the retry.',
    })
    const retry = await kit.reconcile()

    expect(retry).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'A title available without AI',
        metaTitle: 'A title available without AI',
        metaDescription: 'A description available without AI.',
      }),
    )
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain(
      '- Description: A description from the retry.',
    )
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: done')
  })

  it('retitles the note H1, screenshot alt, and daily link text from the AI title', async () => {
    await drainOne()
    kit.describeMock.mockResolvedValue({
      title: 'A Cleaned Up Article',
      description: 'An AI description of the page.',
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A Cleaned Up Article')
    expect(note).not.toContain('# An article')
    expect(note).toContain(`![A Cleaned Up Article](${IDENTITY.assetPath})`)
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('captureProvider: openai')
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily).toContain('- [[capture-2026-06-11-153022-845-7c9e|A Cleaned Up Article]]')
    expect(daily).not.toContain('|An article]]')
  })

  it('keeps the captured title when the AI answer matches it — the daily is never rewritten', async () => {
    await drainOne()
    kit.describeMock.mockResolvedValue({
      title: 'An article',
      description: 'An AI description of the page.',
    })

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('# An article')
    expect(kit.writeNoteMock.mock.calls.filter(([path]) => path === DAILY)).toHaveLength(0)
  })

  it('keeps the captured title when the model produced no usable one', async () => {
    await drainOne()

    await kit.reconcile()

    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('# An article')
    expect(kit.noteFile.files().get(DAILY)).toContain('|An article]]')
    expect(kit.writeNoteMock.mock.calls.filter(([path]) => path === DAILY)).toHaveLength(0)
  })

  it('preserves daily edits made while the provider call was in flight', async () => {
    await drainOne()
    kit.describeMock.mockImplementation(async () => {
      kit.noteFile.set(
        DAILY,
        `${kit.noteFile.files().get(DAILY) ?? ''}\n- jotted down mid-enrichment\n`,
      )
      return { title: 'A Cleaned Up Article', description: 'An AI description of the page.' }
    })

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily).toContain('- jotted down mid-enrichment')
    expect(daily).toContain('|A Cleaned Up Article]]')
  })

  it('resumes the exact metadata checkpoint when its daily write fails', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A title from metadata',
      description: 'A scraped description.',
      siteName: null,
    })
    kit.writeNoteMock
      .mockImplementationOnce(async (path, contents) => {
        kit.noteFile.set(path, contents)
        return { merged: null }
      })
      .mockRejectedValueOnce({ kind: 'io', message: 'disk full' })

    const first = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(first.stopped?.reason).toBe('io')
    expect(kit.noteFile.files().get(DAILY)).toContain('|example.com]]')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('# A title from metadata')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: pending')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain(
      'captureDailyFromTitle: example.com',
    )
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureFinalizeStatus: pending')

    kit.scrapeMock.mockResolvedValue({
      title: 'A different title on retry',
      description: 'A different description on retry.',
      siteName: null,
    })

    const retry = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(retry).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    expect(kit.noteFile.files().get(DAILY)).toContain('|A title from metadata]]')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('# A title from metadata')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).not.toContain('A different title on retry')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: done')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).not.toContain('captureDailyFromTitle')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).not.toContain('captureFinalizeStatus')
    expect(kit.scrapeMock).toHaveBeenCalledTimes(1)
  })

  it('runs newly configured AI after resuming a metadata-only daily retitle', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A title from metadata',
      description: 'A scraped description.',
      siteName: null,
    })
    kit.writeNoteMock
      .mockImplementationOnce(async (path, contents) => {
        kit.noteFile.set(path, contents)
        return { merged: null }
      })
      .mockRejectedValueOnce(new ReflectError('io', 'disk full'))

    const first = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(first.stopped?.reason).toBe('io')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureFinalizeStatus: pending')

    kit.scrapeMock.mockClear()
    kit.installSecrets()
    const waiting = await kit.reconcile()

    expect(waiting).toEqual({
      pending: 1,
      enriched: 0,
      skipped: 0,
      stopped: expect.objectContaining({ reason: 'config' }),
    })
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).not.toHaveBeenCalled()
    expect(kit.noteFile.files().get(DAILY)).toContain('|A title from metadata]]')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: pending')
    expect(kit.noteFile.files().get(IDENTITY.notePath)).not.toContain('captureFinalizeStatus')

    kit.installSecrets({ [API_KEY_SECRET]: 'sk-live-key' })
    kit.describeMock.mockResolvedValue({
      title: 'A title from AI',
      description: 'An AI description.',
    })
    const retry = await kit.reconcile()

    expect(retry).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'A title from metadata',
        metaTitle: 'A title from metadata',
        metaDescription: 'A scraped description.',
      }),
    )
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A title from AI')
    expect(note).toContain('- Description: An AI description.')
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('captureProvider: openai')
    expect(note).not.toContain('captureFinalizeStatus')
    expect(kit.noteFile.files().get(DAILY)).toContain('|A title from AI]]')
  })

  it('preserves privacy set while a metadata retitle writes the daily backlink', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A title from metadata',
      description: 'A scraped description.',
      siteName: null,
    })
    kit.writeNoteMock
      .mockImplementationOnce(async (path, contents) => {
        kit.noteFile.set(path, contents)
        return { merged: null }
      })
      .mockImplementationOnce(async (path, contents) => {
        kit.noteFile.set(path, contents)
        const prepared = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
        kit.noteFile.set(IDENTITY.notePath, prepared.replace('---\n', '---\nprivate: true\n'))
        return { merged: null }
      })

    const outcome = await kit.reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({ pending: 1, enriched: 0, skipped: 1, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('private: true')
    expect(note).toContain('# A title from metadata')
    expect(note).toContain('captureStatus: skipped')
    expect(note).not.toContain('captureDailyFromTitle')
    expect(note).not.toContain('captureFinalizeStatus')
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('does not overwrite capture edits made after metadata enrichment', async () => {
    await drainOne({ source: 'ios-share', title: '' })
    kit.scrapeMock.mockResolvedValue({
      title: 'A scraped title',
      description: 'A scraped description.',
      siteName: null,
    })
    kit.describeMock.mockImplementation(async () => {
      const staged = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
      kit.noteFile.set(IDENTITY.notePath, staged.replace('# A scraped title', '# My edited title'))
      return { title: 'An AI title', description: 'An AI description.' }
    })

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 1, enriched: 0, skipped: 1, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# My edited title')
    expect(note).toContain('- Description: A scraped description.')
    expect(note).not.toContain('An AI description.')
    expect(note).toContain('captureStatus: skipped')
  })

  it('leaves a user-edited daily link text alone while still retitling the note', async () => {
    await drainOne()
    kit.noteFile.set(
      DAILY,
      (kit.noteFile.files().get(DAILY) ?? '').replace('|An article]]', '|my own link text]]'),
    )
    kit.describeMock.mockResolvedValue({
      title: 'A Cleaned Up Article',
      description: 'An AI description of the page.',
    })

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('# A Cleaned Up Article')
    expect(kit.noteFile.files().get(DAILY)).toContain('|my own link text]]')
  })

  it('an AI title with a blank description retitles, stamps provenance, and keeps the scraped description', async () => {
    await drainOne()
    kit.scrapeMock.mockResolvedValue({
      title: 'An article',
      description: 'A scraped description.',
      siteName: null,
    })
    kit.describeMock.mockResolvedValue({ title: 'A Cleaned Up Article', description: '' })

    const outcome = await kit.reconcile()

    expect(outcome.enriched).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).toContain('# A Cleaned Up Article')
    expect(note).toContain('- Description: A scraped description.')
    expect(note).toContain('captureProvider: openai')
    expect(note).toContain('captureModel: gpt-5.5')
  })

  it('never re-enriches done or skipped captures', async () => {
    await drainOne()
    await kit.reconcile()

    const outcome = await kit.reconcile()

    expect(outcome).toEqual({ pending: 0, enriched: 0, skipped: 0, stopped: null })
  })
})
