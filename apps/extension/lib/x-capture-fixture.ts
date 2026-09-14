import type { XPost } from '@post-embed/types'

/** Synthetic data for capture boundary and media tests. */
export function captureFixture(): XPost {
  return {
    id: '20',
    createdAt: '2026-09-14T00:00:00.000Z',
    author: { name: 'Example', handle: 'example', avatar: 'https://pbs.twimg.com/avatar.jpg' },
    body: [
      { type: 'text', text: '中文 and emoji 🌱' },
      { type: 'link', text: ' example', url: 'https://example.com/' },
    ],
    media: [
      { type: 'photo', url: 'https://pbs.twimg.com/photo.jpg', width: 10, height: 10 },
      {
        type: 'video',
        width: 10,
        height: 10,
        poster: 'https://pbs.twimg.com/poster.jpg',
        sources: [
          { type: 'application/x-mpegURL', url: 'https://video.twimg.com/video.m3u8' },
          { type: 'video/mp4', url: 'https://video.twimg.com/low.mp4', bitrate: 10 },
          { type: 'video/mp4', url: 'https://video.twimg.com/high.mp4', bitrate: 100 },
        ],
      },
    ],
    quote: {
      id: '21',
      createdAt: '2026-09-13T00:00:00.000Z',
      author: { name: 'Quoted', handle: 'quoted' },
      body: [{ type: 'text', text: 'Quoted text' }],
      truncated: true,
      media: [
        {
          type: 'gif',
          width: 10,
          height: 10,
          unavailable: true,
          poster: 'https://pbs.twimg.com/quote.jpg',
          sources: [{ type: 'application/x-mpegURL', url: 'https://video.twimg.com/quote.m3u8' }],
        },
      ],
    },
  }
}
