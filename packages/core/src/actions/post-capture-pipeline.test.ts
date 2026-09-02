import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors'
import {
  addSpool,
  DAILY,
  describeMock,
  drain,
  envelope,
  files,
  IDENTITY,
  jsonFetchMock,
  mediaFetchMock,
  NO_PROVIDERS,
  reconcile,
  scrapeMock,
  spool,
  wireCaptureMocks,
  writeAssetMock,
} from './capture-harness'
import type { CapturedPost } from './capture-envelope'

const ensureBacklinkTargetMock = vi.hoisted(() => vi.fn())

vi.mock('../graph/commands', () => ({
  captureInboxList: vi.fn(),
  captureInboxRead: vi.fn(),
  captureInboxReject: vi.fn(),
  captureInboxRemove: vi.fn(),
  captureJsonFetch: vi.fn(),
  captureLinkPreview: vi.fn(),
  captureMediaFetch: vi.fn(),
  listFiles: vi.fn(),
  promoteCaptureScreenshot: vi.fn(),
  readAsset: vi.fn(),
  readNote: vi.fn(),
  writeAsset: vi.fn(),
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

const POST_URL = 'https://x.com/jack/status/20'
const BASE = IDENTITY.base

const JACK_ANSWER = JSON.stringify({
  __typename: 'Tweet',
  created_at: '2006-03-21T20:50:14.000Z',
  display_text_range: [0, 24],
  entities: {},
  id_str: '20',
  text: 'just setting up my twttr',
  user: { name: 'jack', screen_name: 'jack' },
})

const PHOTO_ANSWER = JSON.stringify({
  __typename: 'Tweet',
  created_at: '2024-03-21T14:20:33.000Z',
  display_text_range: [0, 5],
  id_str: '20',
  text: 'photo',
  user: { name: 'jack', screen_name: 'jack' },
  mediaDetails: [
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg', ext_alt_text: 'One' },
    { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg' },
  ],
})

const PAGE_POST: CapturedPost = {
  provider: 'x',
  id: '20',
  trigger: 'bookmark',
  author: { name: 'jack', handle: 'jack' },
  text: 'just setting up my twttr',
  media: [{ kind: 'image', url: 'https://pbs.twimg.com/media/page.jpg?name=large' }],
}

beforeEach(() => {
  wireCaptureMocks()
  ensureBacklinkTargetMock.mockResolvedValue('Links')
})

describe('drainCaptureInbox for posts', () => {
  it('turns a URL-only permalink capture into a post note, canonicalizing the URL', async () => {
    addSpool(envelope({ url: 'https://twitter.com/jack/status/20?s=46', title: 'jack on X' }))

    const outcome = await drain()

    expect(outcome).toMatchObject({ drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = files.get(IDENTITY.notePath)
    expect(note).toContain(`captureUrl: ${POST_URL}`)
    expect(note).toContain('captureKind: post')
    expect(note).toContain('postId: "20"')
    expect(note).toContain('postTrigger: manual')
    expect(note).toContain('captureStatus: pending')
    expect(note).toContain(`# jack on X\n\n- URL: ${POST_URL}\n- Type: #tweet\n`)
    expect(note).toContain(`## Screenshot\n\n![jack on X](${IDENTITY.assetPath})`)
    expect(files.get(DAILY)).toContain(`- [[${BASE}|jack on X]]`)
  })

  it('renders the page-read post block and titles the note from it', async () => {
    addSpool(
      envelope({
        url: 'https://x.com/i/web/status/20',
        title: 'X',
        note: 'check later',
        post: { ...PAGE_POST, truncated: true, postedAt: '2006-03-21T20:50:14.000Z' },
      }),
      { screenshot: false },
    )

    await drain()

    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain(`captureUrl: ${POST_URL}`)
    expect(note).toContain('postTrigger: bookmark')
    expect(note).toContain('postTruncated: true')
    expect(note).toContain('# jack (@jack): just setting up my twttr')
    expect(note).toContain('- Author: [jack](https://x.com/jack) (@jack)')
    expect(note).toContain('- Posted: 2006-03-21')
    expect(note).toContain(`> just setting up my twttr\n> [Read the full post on X](${POST_URL})`)
    expect(note).toContain('![](https://pbs.twimg.com/media/page.jpg?name=large)')
    expect(note).toContain('## Note\n\ncheck later')
    expect(note).not.toContain('## Screenshot')
    expect(files.get(DAILY)).toContain(`- [[${BASE}|jack (@jack): just setting up my twttr]]`)
  })

  it('merges a same-day URL-only re-capture into the bookmark note instead of replacing it', async () => {
    addSpool(envelope({ url: POST_URL, title: 'X', post: PAGE_POST }), { screenshot: false })
    expect((await drain()).deduped).toBe(0)
    addSpool(
      envelope({
        id: '11111111-2222-4333-8444-555555555555',
        url: 'https://twitter.com/i/web/status/20',
        title: 'jack on X',
        note: 'read this later',
      }),
      { screenshot: false },
    )

    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain('# jack (@jack): just setting up my twttr')
    expect(note).toContain('- Author: [jack](https://x.com/jack) (@jack)')
    expect(note).toContain('> just setting up my twttr')
    expect(note).toContain('![](https://pbs.twimg.com/media/page.jpg?name=large)')
    expect(note).toContain('## Note\n\nread this later')
    expect(note).toContain(`captureUrl: ${POST_URL}`)
    expect(note).toContain('postTrigger: bookmark')
    expect(files.get(DAILY)).toContain(`- [[${BASE}|jack (@jack): just setting up my twttr]]`)
  })

  it('leaves a same-day post note the user edited untouched', async () => {
    addSpool(envelope({ url: POST_URL, title: 'X', post: PAGE_POST }), { screenshot: false })
    expect((await drain()).stopped).toBeNull()
    const edited = `${files.get(IDENTITY.notePath)!}\nMy own thoughts on this.\n`
    files.set(IDENTITY.notePath, edited)
    const dailyBefore = files.get(DAILY)
    addSpool(envelope({ id: '11111111-2222-4333-8444-555555555555', url: POST_URL, title: 'X' }), {
      screenshot: false,
    })

    const outcome = await drain()

    expect(outcome).toMatchObject({ drained: 1, deduped: 1, stopped: null })
    expect(files.get(IDENTITY.notePath)).toBe(edited)
    expect(files.get(DAILY)).toBe(dailyBefore)
    expect(spool.size).toBe(0)
  })

  it('dedupes the same post across spellings within the day', async () => {
    addSpool(envelope({ url: 'https://twitter.com/i/web/status/20', title: 'X' }), {
      screenshot: false,
    })
    expect((await drain()).deduped).toBe(0)
    addSpool(
      envelope({
        id: '11111111-2222-4333-8444-555555555555',
        url: 'https://x.com/jack/status/20',
        title: 'X',
        post: PAGE_POST,
      }),
      { screenshot: false },
    )

    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    expect([...files.keys()].filter((path) => path.startsWith('notes/'))).toHaveLength(1)
    expect(files.get(DAILY)?.match(/\[\[capture-/g)).toHaveLength(1)
  })
})

describe('reconcileCaptureEnrichment for posts', () => {
  async function drainPost(overrides: Parameters<typeof envelope>[0] = {}): Promise<void> {
    addSpool(envelope({ url: POST_URL, title: 'jack on X', ...overrides }), { screenshot: false })
    expect((await drain()).stopped).toBeNull()
  }

  it('completes a URL-only capture from the endpoint and retitles the daily entry', async () => {
    await drainPost()
    jsonFetchMock.mockResolvedValue(JACK_ANSWER)

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('# jack (@jack): just setting up my twttr')
    expect(note).toContain('- Author: [jack](https://x.com/jack) (@jack)')
    expect(note).toContain('- Posted: 2006-03-21')
    expect(note).toContain('> just setting up my twttr')
    expect(note).not.toContain('postTruncated')
    expect(files.get(DAILY)).toContain(`- [[${BASE}|jack (@jack): just setting up my twttr]]`)
    expect(scrapeMock).not.toHaveBeenCalled()
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('upgrades a handle-less permalink once the endpoint names the author', async () => {
    await drainPost({ url: 'https://twitter.com/i/web/status/20' })
    expect(files.get(IDENTITY.notePath)).toContain('captureUrl: https://x.com/i/status/20')
    jsonFetchMock.mockResolvedValue(JACK_ANSWER)

    await reconcile({ providers: NO_PROVIDERS })

    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain(`captureUrl: ${POST_URL}`)
    expect(note).toContain(`- URL: ${POST_URL}`)
  })

  it('never calls the AI leg even with a provider configured', async () => {
    await drainPost()
    jsonFetchMock.mockResolvedValue(JACK_ANSWER)

    const outcome = await reconcile()

    expect(outcome.enriched).toBe(1)
    expect(describeMock).not.toHaveBeenCalled()
    expect(files.get(IDENTITY.notePath)).not.toContain('captureProvider')
  })

  it('downloads media into the graph and keeps a failed one remote', async () => {
    await drainPost()
    jsonFetchMock.mockResolvedValue(PHOTO_ANSWER)
    mediaFetchMock
      .mockResolvedValueOnce(btoa('one'))
      .mockRejectedValueOnce(new ReflectError('io', 'answered 404'))

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome.enriched).toBe(1)
    expect(mediaFetchMock).toHaveBeenNthCalledWith(
      1,
      'https://pbs.twimg.com/media/a.jpg?name=large',
    )
    expect(writeAssetMock).toHaveBeenCalledWith(`assets/${BASE}-1.jpg`, btoa('one'), 3)
    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain(`![One](assets/${BASE}-1.jpg)`)
    expect(note).toContain(
      `![](https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg)\n[Watch on X](${POST_URL})`,
    )
  })

  it('keeps the page fields when the endpoint has nothing, and finishes', async () => {
    await drainPost({ post: PAGE_POST })

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toEqual({ pending: 1, enriched: 1, skipped: 0, stopped: null })
    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain('captureStatus: done')
    expect(note).toContain('> just setting up my twttr')
    expect(note).toContain(`![](assets/${BASE}-1.jpg)`)
    expect(mediaFetchMock).toHaveBeenCalledWith('https://pbs.twimg.com/media/page.jpg?name=large')
  })

  it('leaves the capture pending on a transient endpoint failure', async () => {
    await drainPost()
    jsonFetchMock.mockRejectedValue(new ReflectError('network', 'answered 429'))

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toMatchObject({ enriched: 0, stopped: { reason: 'network' } })
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: pending')
  })

  it('prefers the full page text over the endpoint preview of a long post', async () => {
    await drainPost({ post: { ...PAGE_POST, text: 'the whole long post', media: undefined } })
    jsonFetchMock.mockResolvedValue(
      JSON.stringify({
        __typename: 'Tweet',
        id_str: '20',
        text: 'the whole',
        note_tweet: { id: '20' },
        user: { name: 'jack', screen_name: 'jack' },
      }),
    )

    await reconcile({ providers: NO_PROVIDERS })

    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain('> the whole long post')
    expect(note).not.toContain('Read the full post')
    expect(note).not.toContain('postTruncated')
  })

  it('keeps a long post marked truncated when neither side has the full text', async () => {
    await drainPost({
      post: { ...PAGE_POST, text: 'the whole long', truncated: true, media: undefined },
    })
    jsonFetchMock.mockResolvedValue(
      JSON.stringify({
        __typename: 'Tweet',
        id_str: '20',
        text: 'the whole',
        note_tweet: { id: '20' },
        user: { name: 'jack', screen_name: 'jack' },
      }),
    )

    await reconcile({ providers: NO_PROVIDERS })

    const note = files.get(IDENTITY.notePath)!
    expect(note).toContain('postTruncated: true')
    expect(note).toContain(`> the whole long\n> [Read the full post on X](${POST_URL})`)
    expect(note).toContain('captureStatus: done')
  })

  it('makes no request at all for a capture on a private day', async () => {
    files.set(DAILY, '---\nprivate: true\n---\n# Day\n')
    await drainPost({ post: PAGE_POST })
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: skipped')

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome.pending).toBe(0)
    expect(jsonFetchMock).not.toHaveBeenCalled()
    expect(mediaFetchMock).not.toHaveBeenCalled()
    expect(files.get(IDENTITY.notePath)).toContain(
      '![](https://pbs.twimg.com/media/page.jpg?name=large)',
    )
  })

  it('skips a capture edited since the drain, touching nothing', async () => {
    await drainPost({ post: PAGE_POST })
    files.set(IDENTITY.notePath, files.get(IDENTITY.notePath)!.replace('twttr', 'twitter'))

    const outcome = await reconcile({ providers: NO_PROVIDERS })

    expect(outcome).toMatchObject({ enriched: 0, skipped: 1 })
    expect(jsonFetchMock).not.toHaveBeenCalled()
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: skipped')
  })
})
