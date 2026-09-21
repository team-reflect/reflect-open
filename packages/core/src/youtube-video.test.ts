import { afterEach, expect, it, vi } from 'vitest'
import { setBridge } from './ipc/bridge.ts'
import { fetchYouTubeVideo } from './youtube-video.ts'

afterEach(() => setBridge(null))

const URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=90'

const ANSWER = {
  title: 'Big Buck Bunny',
  author_name: 'Blender',
  author_url: 'https://www.youtube.com/@BlenderOfficial',
  type: 'video',
  height: 113,
  width: 200,
  version: '1.0',
  provider_name: 'YouTube',
  provider_url: 'https://www.youtube.com/',
  thumbnail_height: 360,
  thumbnail_width: 480,
  thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
  html: '<iframe></iframe>',
}

function bridgeAnswering(answer: string) {
  const invoke = vi.fn(async () => answer)
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

it('asks the oEmbed endpoint through the bridge and returns the snapshot with the pasted URL', async () => {
  const invoke = bridgeAnswering(JSON.stringify(ANSWER))
  expect(await fetchYouTubeVideo(URL)).toEqual({
    url: URL,
    title: 'Big Buck Bunny',
    author_name: 'Blender',
    author_url: 'https://www.youtube.com/@BlenderOfficial',
    thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
    thumbnail_width: 480,
    thumbnail_height: 360,
    width: 200,
    height: 113,
  })
  expect(invoke).toHaveBeenCalledExactlyOnceWith('capture_oembed_fetch', {
    url: 'https://www.youtube.com/oembed?url=' + encodeURIComponent(URL) + '&format=json',
  })
})

it('does not call the bridge for a URL that is not a YouTube video', async () => {
  const invoke = bridgeAnswering('{}')
  expect(await fetchYouTubeVideo('https://example.com/watch?v=aqz-KE-bpKQ')).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
})

it('rejects when the fetch fails', async () => {
  setBridge({
    invoke: async () => {
      throw { kind: 'io', message: 'answered 404' }
    },
    listen: async () => () => {},
  })
  await expect(fetchYouTubeVideo(URL)).rejects.toMatchObject({ kind: 'io' })
})

it('rejects an answer that is not an object', async () => {
  bridgeAnswering('null')
  await expect(fetchYouTubeVideo(URL)).rejects.toThrow('invalid oEmbed answer')
})
