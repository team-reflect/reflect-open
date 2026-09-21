import type { YouTubeVideoResolver } from '@meowdown/core'
import { fetchYouTubeVideo } from '@reflect/core'
import { queryOptions } from '@tanstack/react-query'
import { queryClient, queryKeys } from '@/lib/query-client.ts'

// A video no note shows is dropped this long after its last read.
const YOUTUBE_VIDEO_GC_TIME_MS = 30 * 60 * 1000

function youTubeVideoQueryOptions(url: string) {
  return queryOptions({
    queryKey: queryKeys.youTubeVideo.video(url),
    queryFn: () => fetchYouTubeVideo(url),
    // A found video stays fresh for the session; a missing one is asked again.
    staleTime: (query) => (query.state.data == null ? 0 : Infinity),
    gcTime: YOUTUBE_VIDEO_GC_TIME_MS,
    retry: false,
  })
}

async function loadYouTubeVideo(url: string) {
  try {
    return (await queryClient.query(youTubeVideoQueryOptions(url))) ?? undefined
  } catch (cause) {
    console.error('YouTube video fetch failed:', url, cause)
    return
  }
}

export const resolveYouTubeVideo: YouTubeVideoResolver = (url) => {
  return queryClient.getQueryData(youTubeVideoQueryOptions(url).queryKey) ?? loadYouTubeVideo(url)
}
