import { afterEach, expect, it, vi } from 'vitest'
import { fetchYouTubeVideo } from '@reflect/core'
import { queryClient } from '@/lib/query-client.ts'
import { resolveYouTubeVideo } from './youtube-video-resolver.ts'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  fetchYouTubeVideo: vi.fn(),
}))
const fetchVideo = vi.mocked(fetchYouTubeVideo)

afterEach(() => {
  queryClient.clear()
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

const URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

const VIDEO = {
  url: URL,
  title: 'Big Buck Bunny',
  author_name: 'Blender',
  author_url: 'https://www.youtube.com/@BlenderOfficial',
  thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
  thumbnail_width: 480,
  thumbnail_height: 360,
  width: 200,
  height: 113,
}

it('returns a fetched video synchronously the second time', async () => {
  fetchVideo.mockResolvedValue(VIDEO)
  const first = resolveYouTubeVideo(URL)
  expect(first).toBeInstanceOf(Promise)
  expect(await first).toEqual(VIDEO)
  expect(resolveYouTubeVideo(URL)).toEqual(VIDEO)
  expect(fetchVideo).toHaveBeenCalledExactlyOnceWith(URL)
})

it('asks again after a missing answer', async () => {
  fetchVideo.mockResolvedValueOnce(null)
  expect(await resolveYouTubeVideo(URL)).toBeUndefined()
  fetchVideo.mockResolvedValueOnce(VIDEO)
  expect(await resolveYouTubeVideo(URL)).toEqual(VIDEO)
})

it('logs a failed fetch and asks again', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const cause = new Error('offline')
  fetchVideo.mockRejectedValueOnce(cause)
  expect(await resolveYouTubeVideo(URL)).toBeUndefined()
  expect(logged).toHaveBeenCalledExactlyOnceWith('YouTube video fetch failed:', URL, cause)
  fetchVideo.mockResolvedValueOnce(VIDEO)
  expect(await resolveYouTubeVideo(URL)).toEqual(VIDEO)
})
