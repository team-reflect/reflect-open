import type { XPost } from '@post-embed/types'
export const VIDEO_MAX_BYTES = 10_000_000
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024
export const CAPTURE_MESSAGE_MAX_BYTES = 512 * 1024
export const ASSET_CHUNK_MAX_BYTES = 256 * 1024
export type ResourceError = 'network' | 'authentication' | 'source-missing' | 'storage'
  | 'format' | 'unsupported-hls' | 'video-too-large'
export interface ArchiveResource {
  url: string
  state: 'pending' | 'stored' | 'failed' | 'unsupported'
  error?: ResourceError
}
export interface ArchivedXPost {
  kind: 'x-post'
  id: string
  revision: string
  capturedAt: string
  textState: 'complete' | 'partial' | 'unknown'
  data: XPost
  resources: ArchiveResource[]
}
export interface ArchiveReceipt { name: string; bytes: number; mime: string; sha256?: string }
export interface ArchiveJob {
  id: string
  resource: ArchiveResource
  postIds: string[]
  state: ArchiveResource['state'] | 'downloading'
  lease: string | null
  leaseUntil: number
  offset: number
  receipt: ArchiveReceipt | null
}
export type ArchiveRequest =
  | { op: 'work.bind' }
  | { op: 'capture.put'; envelope: object }
  | { op: 'work.pull'; binding: string }
  | { op: 'asset.status'; binding: string; jobId: string }
  | { op: 'asset.append'; binding: string; jobId: string; lease: string; offset: number; data: string }
  | { op: 'asset.commit'; binding: string; jobId: string; lease: string; bytes: number; sha256: string }
  | { op: 'asset.abort'; binding: string; jobId: string; lease: string; reason: ResourceError }

