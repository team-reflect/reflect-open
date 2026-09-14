import type { XPost } from '@post-embed/types'
export const VIDEO_MAX_BYTES = 10_000_000
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024
export interface ArchivedXPost {
  kind: 'x-post'
  capturedAt: string
  data: XPost
}
