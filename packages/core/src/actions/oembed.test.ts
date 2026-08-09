import { describe, expect, it } from 'vitest'
import { oembedRequestURL, parseOEmbedAnswer } from './oembed'

describe('oembedRequestURL', () => {
  it('builds the YouTube request with the capture URL form-encoded', () => {
    expect(oembedRequestURL('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
    )
  })

  it.each([
    'https://youtu.be/dQw4w9WgXcQ?si=abc123',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0abc&t=42',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'http://youtu.be/dQw4w9WgXcQ',
  ])('claims %s', (url) => {
    expect(oembedRequestURL(url)).toContain('https://www.youtube.com/oembed?')
  })

  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com/@RickAstleyYT',
    'https://www.youtube.com/playlist?list=PL0abc',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/results?search_query=rick+astley',
    'https://youtu.be/',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'ftp://youtu.be/dQw4w9WgXcQ',
    'not a url',
  ])('leaves %s to the HTML scrape', (url) => {
    expect(oembedRequestURL(url)).toBeNull()
  })
})

describe('parseOEmbedAnswer', () => {
  it('reads the title and provider name', () => {
    const json =
      '{"title":"Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)","author_name":"Rick Astley","provider_name":"YouTube","type":"video"}'
    expect(parseOEmbedAnswer(json)).toEqual({
      title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      providerName: 'YouTube',
    })
  })

  it('treats an absent provider name as null', () => {
    expect(parseOEmbedAnswer('{"title":"T"}')).toEqual({ title: 'T', providerName: null })
  })

  it('reads malformed JSON and a wrong shape as null', () => {
    expect(parseOEmbedAnswer('<html>')).toBeNull()
    expect(parseOEmbedAnswer('{"error":"Bad Request"}')).toBeNull()
  })
})
