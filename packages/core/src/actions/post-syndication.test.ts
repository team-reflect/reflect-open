import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors'
import { captureJsonFetch } from '../graph/commands'
import {
  fetchSyndicatedPost,
  postFromSyndication,
  syndicatedText,
  syndicationAnswerSchema,
  syndicationRequestUrl,
  syndicationToken,
} from './post-syndication'

vi.mock('../graph/commands', () => ({
  captureJsonFetch: vi.fn(),
}))

const jsonFetchMock = vi.mocked(captureJsonFetch)

/** The live answer for https://x.com/jack/status/20 (2026-09-02), trimmed. */
const JACK = {
  __typename: 'Tweet',
  lang: 'en',
  created_at: '2006-03-21T20:50:14.000Z',
  display_text_range: [0, 24],
  entities: {},
  id_str: '20',
  text: 'just setting up my twttr',
  user: { id_str: '12', name: 'jack', screen_name: 'jack' },
}

/** A reply whose visible text is empty once the mention and media link are ranged out. */
const PHOTO_REPLY = {
  __typename: 'Tweet',
  in_reply_to_screen_name: 'jack',
  created_at: '2024-03-21T14:20:33.000Z',
  display_text_range: [5, 5],
  entities: {
    media: [{ url: 'https://t.co/j0vbZrENcJ' }],
    urls: [],
  },
  id_str: '1770888775830262034',
  text: '@jack https://t.co/j0vbZrENcJ',
  user: { name: 'Derbeder', screen_name: 'derbederdusler' },
  mediaDetails: [
    {
      type: 'photo',
      media_url_https: 'https://pbs.twimg.com/media/GJN19MHXQAAeNDq.jpg',
      ext_alt_text: 'A poodle',
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('syndicationRequestUrl', () => {
  it('computes the token react-tweet computes', () => {
    expect(syndicationToken('20')).toBe('6dq1a2xwd93')
    expect(syndicationToken('1770888775830262034')).toBe('4ajesvh5936')
  })

  it('asks the endpoint with id, language, features, and token', () => {
    const url = new URL(syndicationRequestUrl('20'))
    expect(url.origin + url.pathname).toBe('https://cdn.syndication.twimg.com/tweet-result')
    expect(url.searchParams.get('id')).toBe('20')
    expect(url.searchParams.get('lang')).toBe('en')
    expect(url.searchParams.get('token')).toBe('6dq1a2xwd93')
    expect(url.searchParams.get('features')).toContain('tfw_tweet_edit_frontend:on')
  })
})

describe('postFromSyndication', () => {
  it('maps a text-only post', () => {
    const answer = syndicationAnswerSchema.parse(JACK)
    expect(postFromSyndication(answer, 'bookmark')).toEqual({
      provider: 'x',
      id: '20',
      trigger: 'bookmark',
      author: { name: 'jack', handle: 'jack' },
      text: 'just setting up my twttr',
      postedAt: '2006-03-21T20:50:14.000Z',
    })
  })

  it('maps a photo reply: ranged-out text is absent, the photo is full size', () => {
    const answer = syndicationAnswerSchema.parse(PHOTO_REPLY)
    expect(postFromSyndication(answer, 'manual')).toEqual({
      provider: 'x',
      id: '1770888775830262034',
      trigger: 'manual',
      author: { name: 'Derbeder', handle: 'derbederdusler' },
      postedAt: '2024-03-21T14:20:33.000Z',
      media: [
        {
          kind: 'image',
          url: 'https://pbs.twimg.com/media/GJN19MHXQAAeNDq.jpg?name=large',
          alt: 'A poodle',
        },
      ],
    })
  })

  it('marks a long-form post truncated and maps the quoted post', () => {
    const answer = syndicationAnswerSchema.parse({
      ...JACK,
      note_tweet: { id: '20' },
      quoted_tweet: {
        id_str: '1770825760162353449',
        text: 'Hello from the future &amp; beyond https://t.co/abc',
        entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/x' }] },
        user: { name: 'Lex Fridman', screen_name: 'lexfridman' },
        created_at: '2024-03-21T18:00:00.000Z',
      },
      mediaDetails: [
        { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg' },
        { type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg' },
        { type: 'hologram', media_url_https: 'https://pbs.twimg.com/media/ignored.jpg' },
      ],
    })
    const post = postFromSyndication(answer, 'bookmark')
    expect(post?.truncated).toBe(true)
    expect(post?.media).toEqual([
      { kind: 'video', url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg' },
      { kind: 'gif', url: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg' },
    ])
    expect(post?.quoted).toEqual({
      id: '1770825760162353449',
      url: 'https://x.com/lexfridman/status/1770825760162353449',
      author: { name: 'Lex Fridman', handle: 'lexfridman' },
      text: 'Hello from the future & beyond https://example.com/x',
      postedAt: '2024-03-21T18:00:00.000Z',
    })
  })

  it('caps media at four', () => {
    const answer = syndicationAnswerSchema.parse({
      ...JACK,
      mediaDetails: Array.from({ length: 6 }, (_, index) => ({
        type: 'photo',
        media_url_https: `https://pbs.twimg.com/media/${index}.jpg`,
      })),
    })
    expect(postFromSyndication(answer, 'manual')?.media).toHaveLength(4)
  })

  it('reads a tombstone as null', () => {
    const answer = syndicationAnswerSchema.parse({ __typename: 'TweetTombstone', tombstone: {} })
    expect(postFromSyndication(answer, 'manual')).toBeNull()
  })
})

describe('syndicatedText', () => {
  it('slices by code points, expands links, and decodes entities', () => {
    expect(
      syndicatedText({
        id_str: '1',
        text: '@a 😀 fish &amp; chips https://t.co/x https://t.co/media',
        display_text_range: [3, 36],
        entities: {
          urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com/fish' }],
        },
      }),
    ).toBe('😀 fish & chips https://example.com/fish')
  })
})

describe('fetchSyndicatedPost', () => {
  it('returns the post for a JSON answer', async () => {
    jsonFetchMock.mockResolvedValue(JSON.stringify(JACK))
    const outcome = await fetchSyndicatedPost('20', 'bookmark')
    expect(outcome.kind).toBe('post')
    expect(jsonFetchMock).toHaveBeenCalledWith(syndicationRequestUrl('20'))
  })

  it('propagates transient failures for retry', async () => {
    jsonFetchMock.mockRejectedValue(new ReflectError('network', 'answered 429'))
    await expect(fetchSyndicatedPost('20', 'bookmark')).rejects.toMatchObject({ kind: 'network' })
  })

  it.each([
    ['a 404', () => jsonFetchMock.mockRejectedValue(new ReflectError('io', 'answered 404'))],
    ['a non-JSON answer', () => jsonFetchMock.mockRejectedValue(new ReflectError('parse', 'html'))],
    ['malformed JSON', () => jsonFetchMock.mockResolvedValue('<html>')],
    ['an unrecognized shape', () => jsonFetchMock.mockResolvedValue('{"error":"nope"}')],
    ['an empty object', () => jsonFetchMock.mockResolvedValue('{}')],
    [
      'a tombstone',
      () => jsonFetchMock.mockResolvedValue('{"__typename":"TweetTombstone","tombstone":{}}'),
    ],
  ])('reads %s as unavailable', async (_label, arrange) => {
    arrange()
    await expect(fetchSyndicatedPost('20', 'bookmark')).resolves.toEqual({ kind: 'unavailable' })
  })
})
