import { beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { AppError } from '../errors.ts'
import { appendXPost } from './bookmark-capture.ts'
import type { XPostEnvelope } from './bookmark-envelope.ts'
import type { XArchiveService } from '../embeds/x-archive-service.ts'
import type { DrainCaptureInboxInput } from './capture-drain-service.ts'
import { createCaptureTestKit, type CaptureTestKit } from './capture-test-kit.ts'

const envelope: XPostEnvelope = {
  version: 2,
  kind: 'x-bookmark',
  data: { id: '20', createdAt: '', author: { name: '', handle: '' }, body: [] },
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  source: 'extension',
  capturedAt: '2026-09-09T04:00:00Z',
}

let kit: CaptureTestKit
let saveArchivedPost: MockInstance<XArchiveService['write']>

function drainCaptureInbox(input: Pick<DrainCaptureInboxInput, 'writeXPost'> = {}) {
  return kit.drain({ generation: 1, ...input })
}

function spoolEnvelope(capture: object): void {
  kit.captureInbox.add(`${envelope.id}.json`, capture, { modifiedMs: 1 })
}

beforeEach(() => {
  kit = createCaptureTestKit()
  saveArchivedPost = vi.spyOn(kit.xArchive, 'write')
  spoolEnvelope(envelope)
})

it('replays after a crash between note commit and spool cleanup without duplicating', async () => {
  let source = 'My journal\n'
  const writeXPost = vi.fn(async (capture: XPostEnvelope, path: string) => {
    expect(path).toMatch(/^daily\/2026-09-0[89]\.md$/)
    source = appendXPost(source, capture)
  })
  kit.inboxRemoveMock.mockRejectedValueOnce(new AppError('io', 'cleanup failed'))
  expect((await drainCaptureInbox({ writeXPost })).stopped?.reason).toBe('io')
  const committed = source
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(1)
  expect(source).toBe(committed)
  expect(kit.writeNoteMock).not.toHaveBeenCalled()
})

it('keeps the spool when the document is busy or the bookmark writer is unavailable', async () => {
  const writeXPost = vi.fn(async () => {
    throw new Error('Busy daily note')
  })
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(0)
  expect((await drainCaptureInbox()).drained).toBe(0)
  expect(kit.inboxRemoveMock).not.toHaveBeenCalled()
  expect(kit.writeNoteMock).not.toHaveBeenCalled()
})

it('saves the archive before writing Markdown and removes the spool last', async () => {
  const steps: string[] = []
  saveArchivedPost.mockImplementation(async (generation, archive) => {
    expect(generation).toBe(1)
    expect(archive.data).toMatchObject(envelope.data)
    steps.push('archive')
  })
  const writeXPost = vi.fn(async () => {
    steps.push('markdown')
  })
  kit.inboxRemoveMock.mockImplementation(async () => {
    steps.push('remove')
  })
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(1)
  expect(steps).toEqual(['archive', 'markdown', 'remove'])
})

it('retains the inbox and never inserts Markdown when archive persistence fails', async () => {
  saveArchivedPost.mockRejectedValue(new AppError('io', 'disk full'))
  const writeXPost = vi.fn(async () => {})
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(0)
  expect(writeXPost).not.toHaveBeenCalled()
  expect(kit.inboxRemoveMock).not.toHaveBeenCalled()
})

it('writes and deduplicates URL-only bookmarks without touching an archive', async () => {
  const fallback = { ...envelope, data: undefined, postId: '20' }
  spoolEnvelope(fallback)
  let source = ''
  const writeXPost = async (capture: XPostEnvelope) => {
    source = appendXPost(source, capture)
  }
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(1)
  spoolEnvelope(fallback) // the same bookmark captured again
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(1)
  expect(source).toBe('## X bookmarks\n\n![](https://x.com/i/status/20)\n')
  expect(saveArchivedPost).not.toHaveBeenCalled()
  expect(kit.inboxRemoveMock).toHaveBeenCalledTimes(2)
})

it('drains a like to its capture day and replays after cleanup failure', async () => {
  const like: XPostEnvelope = { ...envelope, kind: 'x-like' }
  spoolEnvelope(like)
  let source = 'Draft prose\n'
  const writeXPost = vi.fn(async (capture: XPostEnvelope, path: string) => {
    expect(capture.kind).toBe('x-like')
    expect(path).toMatch(/^daily\/2026-09-0[89]\.md$/)
    source = appendXPost(source, capture)
  })
  kit.inboxRemoveMock.mockRejectedValueOnce(new AppError('io', 'cleanup failed'))
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(0)
  const committed = source
  expect((await drainCaptureInbox({ writeXPost })).drained).toBe(1)
  expect(source).toBe(committed)
  expect(source).toContain('## X likes')
})
