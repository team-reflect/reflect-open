import { beforeEach, expect, it, vi } from 'vitest'
import { appendBookmark } from './bookmark-capture'
import { drainCaptureInbox } from './capture-drain'
import type { BookmarkEnvelope } from './bookmark-envelope'
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
const envelope: BookmarkEnvelope = {
  version: 2,
  kind: 'x-bookmark',
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  source: 'extension',
  postId: '20',
  capturedAt: '2026-09-09T04:00:00Z',
  captureDate: '2026-09-09',
  targetGraphId: 'a'.repeat(64),
  evidence: 'manual',
  presentation: 'link',
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
  const writeBookmark = vi.fn(async (capture: BookmarkEnvelope) => {
    source = appendBookmark(source, capture)
  })
  vi.mocked(captureInboxRemove).mockRejectedValueOnce({ kind: 'io', message: 'cleanup failed' })
  expect((await drainCaptureInbox({ generation: 1, writeBookmark })).stopped?.reason).toBe('io')
  const committed = source
  expect((await drainCaptureInbox({ generation: 1, writeBookmark })).drained).toBe(1)
  expect(source).toBe(committed)
  expect(writeNote).not.toHaveBeenCalled()
})

it('keeps the spool when the document is busy or the bookmark writer is unavailable', async () => {
  const writeBookmark = vi.fn(async () => {
    throw new Error('Busy daily note')
  })
  expect((await drainCaptureInbox({ generation: 1, writeBookmark })).drained).toBe(0)
  expect((await drainCaptureInbox({ generation: 1 })).drained).toBe(0)
  expect(captureInboxRemove).not.toHaveBeenCalled()
  expect(writeNote).not.toHaveBeenCalled()
})
