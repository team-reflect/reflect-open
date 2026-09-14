import { saveArchivedPost } from '../x-archive'
vi.mock('../x-archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../x-archive')>()),
  saveArchivedPost: vi.fn(async () => {}),
}))
import { beforeEach, expect, it, vi } from 'vitest'
import { appendXPost } from './bookmark-capture'
import { drainCaptureInbox } from './capture-drain'
import type { XPostEnvelope } from './bookmark-envelope'
import {
  captureInboxList,
  captureInboxRead,
  captureInboxRemove,
  writeNote,
} from '../graph/commands'

vi.mock('../graph/commands', () => ({
  captureInboxList: vi.fn(),
  captureInboxRead: vi.fn(),
  captureInboxRemove: vi.fn(),
  captureInboxReject: vi.fn(),
  promoteCaptureScreenshot: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
const envelope: XPostEnvelope = {
  version: 2,
  kind: 'x-bookmark',
  data: { id: '20', createdAt: '', author: { name: '', handle: '' }, body: [] },
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  source: 'extension',
  capturedAt: '2026-09-09T04:00:00Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(captureInboxList).mockResolvedValue([
    { path: `${envelope.id}.json`, size: 400, modifiedMs: 1 },
  ])
  vi.mocked(captureInboxRead).mockResolvedValue(JSON.stringify(envelope))
  vi.mocked(captureInboxRemove).mockResolvedValue(undefined)
})

it('replays after a crash between note commit and spool cleanup without duplicating', async () => {
  let source = 'My journal\n'
  const writeXPost = vi.fn(async (capture: XPostEnvelope, path: string) => {
    expect(path).toMatch(/^daily\/2026-09-0[89]\.md$/)
    source = appendXPost(source, capture)
  })
  vi.mocked(captureInboxRemove).mockRejectedValueOnce({ kind: 'io', message: 'cleanup failed' })
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).stopped?.reason).toBe('io')
  const committed = source
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(1)
  expect(source).toBe(committed)
  expect(writeNote).not.toHaveBeenCalled()
})

it('keeps the spool when the document is busy or the bookmark writer is unavailable', async () => {
  const writeXPost = vi.fn(async () => {
    throw new Error('Busy daily note')
  })
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(0)
  expect((await drainCaptureInbox({ generation: 1 })).drained).toBe(0)
  expect(captureInboxRemove).not.toHaveBeenCalled()
  expect(writeNote).not.toHaveBeenCalled()
})

it('saves the archive before writing Markdown and removes the spool last', async () => {
  const steps: string[] = []
  vi.mocked(saveArchivedPost).mockImplementation(async (generation, archive) => {
    expect(generation).toBe(1)
    expect(archive.data).toMatchObject(envelope.data)
    steps.push('archive')
  })
  const writeXPost = vi.fn(async () => {
    steps.push('markdown')
  })
  vi.mocked(captureInboxRemove).mockImplementation(async () => {
    steps.push('remove')
  })
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(1)
  expect(steps).toEqual(['archive', 'markdown', 'remove'])
})

it('retains the inbox and never inserts Markdown when archive persistence fails', async () => {
  vi.mocked(saveArchivedPost).mockRejectedValue({ kind: 'io', message: 'disk full' })
  const writeXPost = vi.fn(async () => {})
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(0)
  expect(writeXPost).not.toHaveBeenCalled()
  expect(captureInboxRemove).not.toHaveBeenCalled()
})

it('writes and deduplicates URL-only bookmarks without touching an archive', async () => {
  const fallback = { ...envelope, data: undefined, postId: '20' }
  vi.mocked(captureInboxRead).mockResolvedValue(JSON.stringify(fallback))
  let source = ''
  const writeXPost = async (capture: XPostEnvelope) => {
    source = appendXPost(source, capture)
  }
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(1)
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(1)
  expect(source).toBe('## X bookmarks\n\n![](https://x.com/i/status/20)\n')
  expect(saveArchivedPost).not.toHaveBeenCalled()
  expect(captureInboxRemove).toHaveBeenCalledTimes(2)
})

it('drains a like to its capture day and replays after cleanup failure', async () => {
  const like: XPostEnvelope = { ...envelope, kind: 'x-like' }
  vi.mocked(captureInboxRead).mockResolvedValue(JSON.stringify(like))
  let source = 'Draft prose\n'
  const writeXPost = vi.fn(async (capture: XPostEnvelope, path: string) => {
    expect(capture.kind).toBe('x-like')
    expect(path).toMatch(/^daily\/2026-09-0[89]\.md$/)
    source = appendXPost(source, capture)
  })
  vi.mocked(captureInboxRemove).mockRejectedValueOnce({ kind: 'io', message: 'cleanup failed' })
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(0)
  const committed = source
  expect((await drainCaptureInbox({ generation: 1, writeXPost })).drained).toBe(1)
  expect(source).toBe(committed)
  expect(source).toContain('## X likes')
})
