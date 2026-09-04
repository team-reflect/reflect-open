import { describe, expect, it } from 'vitest'
import type { CapturedPost } from './capture-envelope'
import {
  capturedPostFromFields,
  parsePostNoteBody,
  postNoteBody,
  postNoteFields,
  postNoteTitle,
  type PostNoteFields,
} from './post-note'

const URL = 'https://x.com/jack/status/20'

const FULL: PostNoteFields = {
  url: URL,
  author: { name: 'jack', handle: 'jack' },
  postedAt: '2006-03-21T20:50:14.000Z',
  text: 'just setting up my twttr\n\nsecond paragraph with a [link](https://example.com)',
  truncated: false,
  media: [
    { kind: 'image', src: 'https://pbs.twimg.com/media/a.jpg?name=large', alt: 'A poodle' },
    { kind: 'video', src: 'https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg', alt: '' },
  ],
  quoted: {
    id: '1770825760162353449',
    url: 'https://x.com/lexfridman/status/1770825760162353449',
    author: { name: 'Lex Fridman', handle: 'lexfridman' },
    text: 'Hello from the future',
  },
  note: 'check later',
  screenshot: 'assets/capture-2026-06-11-153022-845-7c9e.jpg',
}

describe('postNoteBody', () => {
  it('renders the full template', () => {
    expect(postNoteBody(FULL, 'jack (@jack): just setting up my twttr')).toBe(
      [
        '# jack (@jack): just setting up my twttr',
        '',
        `- URL: ${URL}`,
        '- Type: #tweet',
        '- Author: [jack](https://x.com/jack) (@jack)',
        '- Posted: 2006-03-21',
        '',
        '> just setting up my twttr',
        '>',
        '> second paragraph with a [link](https://example.com)',
        '',
        '![A poodle](https://pbs.twimg.com/media/a.jpg?name=large)',
        '![](https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg)',
        `[Watch on X](${URL})`,
        '',
        '**Quoting** [Lex Fridman (@lexfridman)](https://x.com/lexfridman/status/1770825760162353449):',
        '',
        '> Hello from the future',
        '',
        '## Note',
        '',
        'check later',
        '',
        '## Screenshot',
        '',
        '![jack (@jack): just setting up my twttr](assets/capture-2026-06-11-153022-845-7c9e.jpg)',
        '',
      ].join('\n'),
    )
  })

  it('renders a URL-only capture as metadata alone', () => {
    const fields: PostNoteFields = {
      url: URL,
      author: null,
      postedAt: null,
      text: null,
      truncated: false,
      media: [],
      quoted: null,
      note: null,
      screenshot: null,
    }
    expect(postNoteBody(fields, 'x.com')).toBe(`# x.com\n\n- URL: ${URL}\n- Type: #tweet\n`)
  })

  it('marks a truncated text with the read-more link', () => {
    const body = postNoteBody({ ...FULL, text: 'a long post…', truncated: true }, 'T')
    expect(body).toContain(`> a long post…\n> [Read the full post on X](${URL})`)
  })

  it('keeps bracketed names from breaking the markdown links', () => {
    const body = postNoteBody(
      { ...FULL, author: { name: 'jack [beta] (test)', handle: 'jack' }, quoted: null, media: [] },
      'T',
    )
    expect(body).toContain('- Author: [jack beta test](https://x.com/jack) (@jack)')
  })
})

describe('parsePostNoteBody', () => {
  it('round-trips the full template', () => {
    const title = 'jack (@jack): just setting up my twttr'
    const parsed = parsePostNoteBody(postNoteBody(FULL, title))
    expect(parsed).toEqual({
      ...FULL,
      title,
      postedAt: '2006-03-21',
      media: [
        { kind: 'image', src: 'https://pbs.twimg.com/media/a.jpg?name=large', alt: 'A poodle' },
        { kind: 'video', src: 'https://pbs.twimg.com/ext_tw_video_thumb/1/poster.jpg', alt: '' },
      ],
    })
  })

  it('round-trips the sparse shapes', () => {
    const sparse: PostNoteFields = {
      url: URL,
      author: null,
      postedAt: null,
      text: null,
      truncated: true,
      media: [],
      quoted: null,
      note: 'one\n\ntwo',
      screenshot: null,
    }
    expect(parsePostNoteBody(postNoteBody(sparse, 'x.com'))).toEqual({ ...sparse, title: 'x.com' })

    const quotedOnly: PostNoteFields = {
      ...sparse,
      truncated: false,
      note: null,
      quoted: {
        id: '1',
        url: 'https://x.com/a/status/1',
        author: { name: 'A', handle: 'a' },
      },
    }
    expect(parsePostNoteBody(postNoteBody(quotedOnly, 'T'))).toEqual({ ...quotedOnly, title: 'T' })
  })

  it('rejects a body the template did not produce', () => {
    expect(() => parsePostNoteBody('# T\n\n- URL: https://x.com/a/status/1\n\nprose\n')).toThrow(
      'unrecognized block',
    )
    expect(() => parsePostNoteBody('- URL: https://x.com/a/status/1\n')).toThrow('heading')
  })
})

describe('postNoteTitle', () => {
  it('prefers author and first line, clipped and link-safe', () => {
    expect(
      postNoteTitle(
        { author: { name: 'jack', handle: 'jack' }, text: 'first [line]\nsecond' },
        'x',
      ),
    ).toBe('jack (@jack): first line')
    expect(postNoteTitle({ author: { name: 'jack', handle: 'jack' }, text: null }, 'x')).toBe(
      'jack (@jack) on X',
    )
    expect(postNoteTitle({ author: null, text: '  hello  ' }, 'x')).toBe('Post on X: hello')
    expect(postNoteTitle({ author: null, text: null }, 'fallback')).toBe('fallback')
  })

  it('clips a long first line at a word boundary', () => {
    const title = postNoteTitle(
      { author: { name: 'jack', handle: 'jack' }, text: 'word '.repeat(60) },
      'x',
    )
    expect(title.length).toBeLessThanOrEqual(100)
    expect(title.startsWith('jack (@jack): word word')).toBe(true)
  })
})

describe('postNoteFields / capturedPostFromFields', () => {
  it('maps a captured post to fields and back, dropping localized media', () => {
    const post: CapturedPost = {
      provider: 'x',
      id: '20',
      trigger: 'bookmark',
      author: { name: 'jack', handle: 'jack' },
      text: 'hi',
      postedAt: '2006-03-21T20:50:14.000Z',
      media: [{ kind: 'gif', url: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg', alt: 'loop' }],
    }
    const fields = postNoteFields(URL, post, { note: ' n ', screenshot: null })
    expect(fields.note).toBe('n')
    expect(fields.media).toEqual([
      { kind: 'gif', src: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg', alt: 'loop' },
    ])
    expect(capturedPostFromFields(fields, { id: '20', trigger: 'bookmark' })).toEqual({
      ...post,
      media: [{ kind: 'gif', url: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg', alt: 'loop' }],
    })
    expect(
      capturedPostFromFields(
        { ...fields, media: [{ kind: 'image', src: 'assets/local.jpg', alt: '' }] },
        { id: '20', trigger: 'bookmark' },
      ).media,
    ).toBeUndefined()
  })
})
