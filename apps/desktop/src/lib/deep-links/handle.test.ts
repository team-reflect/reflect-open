import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureInboxSpool,
  resolveNoteTarget,
  textCaptureEnvelopeSchema,
} from '@reflect/core'
import { handleDeepLink } from '@/lib/deep-links/handle'
import { startOperation } from '@/lib/operations'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  captureInboxSpool: vi.fn(),
  resolveNoteTarget: vi.fn(),
}))
vi.mock('@/lib/operations', () => ({
  startOperation: vi.fn(),
}))

const spoolMock = vi.mocked(captureInboxSpool)
const resolveMock = vi.mocked(resolveNoteTarget)
const startOperationMock = vi.mocked(startOperation)
const operationHandle = {
  progress: vi.fn(),
  done: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
  dismiss: vi.fn(),
}
const navigate = vi.fn()

function handle(url: string) {
  return handleDeepLink(url, { navigate, generation: 3 })
}

beforeEach(() => {
  vi.clearAllMocks()
  startOperationMock.mockReturnValue(operationHandle)
})

describe('handleDeepLink', () => {
  it('navigates self-contained routes directly, with no status noise', async () => {
    await handle('reflect://daily/2026-07-01')
    expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-07-01' })
    expect(resolveMock).not.toHaveBeenCalled()
    expect(startOperationMock).not.toHaveBeenCalled()
  })

  it('resolves a note target and navigates to its route', async () => {
    resolveMock.mockResolvedValue('notes/project-x.md')

    await handle('reflect://note/Project%20X')

    expect(resolveMock).toHaveBeenCalledWith('Project X')
    expect(navigate).toHaveBeenCalledWith({ kind: 'note', path: 'notes/project-x.md' })
  })

  it('routes a daily-path resolution to the daily view', async () => {
    resolveMock.mockResolvedValue('daily/2026-07-01.md')

    await handle('reflect://note/2026-07-01')

    expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-07-01' })
  })

  it('surfaces a failure instead of navigating when the target resolves to nothing', async () => {
    resolveMock.mockResolvedValue(null)

    await handle('reflect://note/ghost')

    expect(navigate).not.toHaveBeenCalled()
    expect(startOperationMock).toHaveBeenCalledWith('Opening link')
    expect(operationHandle.fail).toHaveBeenCalledWith('Note not found: ghost')
  })

  it('surfaces a resolution failure instead of rejecting the handler', async () => {
    resolveMock.mockRejectedValue(new Error('index unavailable'))

    await expect(handle('reflect://note/Project%20X')).resolves.toBeUndefined()

    expect(navigate).not.toHaveBeenCalled()
    expect(startOperationMock).toHaveBeenCalledWith('Opening link')
    expect(operationHandle.fail).toHaveBeenCalled()
  })

  it('drops a resolution that finished after the graph session ended', async () => {
    resolveMock.mockResolvedValue('notes/project-x.md')

    await handleDeepLink('reflect://note/Project%20X', {
      navigate,
      generation: 3,
      isStale: () => true,
    })

    expect(navigate).not.toHaveBeenCalled()
    expect(startOperationMock).not.toHaveBeenCalled()
  })

  it('surfaces a failure on a URL the grammar rejects', async () => {
    await handle('reflect://edit-notes?content=evil')

    expect(navigate).not.toHaveBeenCalled()
    expect(spoolMock).not.toHaveBeenCalled()
    expect(startOperationMock).toHaveBeenCalledWith('Opening link')
    expect(operationHandle.fail).toHaveBeenCalledWith(
      'Unrecognized link: reflect://edit-notes?content=evil',
    )
  })

  it('spools a valid text-capture envelope for an append link', async () => {
    await handle('reflect://append?text=call%20the%20bank')

    expect(spoolMock).toHaveBeenCalledTimes(1)
    const [name, json, generation] = spoolMock.mock.calls[0]!
    const envelope = textCaptureEnvelopeSchema.parse(JSON.parse(json))
    expect(name).toBe(`${envelope.id}.json`)
    expect(envelope.kind).toBe('append')
    expect(envelope.text).toBe('call the bank')
    expect(generation).toBe(3)
    expect(navigate).not.toHaveBeenCalled()
    expect(startOperationMock).toHaveBeenCalledWith('Added to today')
    expect(operationHandle.done).toHaveBeenCalled()
  })

  it('spools a task envelope for a task link', async () => {
    await handle('reflect://task?text=buy+milk')

    const [, json] = spoolMock.mock.calls[0]!
    const envelope = textCaptureEnvelopeSchema.parse(JSON.parse(json))
    expect(envelope.kind).toBe('task')
    expect(envelope.text).toBe('buy milk')
    expect(startOperationMock).toHaveBeenCalledWith('Task added to today')
    expect(operationHandle.done).toHaveBeenCalled()
  })

  it('surfaces a spool failure instead of claiming success', async () => {
    spoolMock.mockRejectedValue(new Error('stale generation'))

    await handle('reflect://append?text=milk')

    expect(operationHandle.done).not.toHaveBeenCalled()
    expect(startOperationMock).toHaveBeenCalledWith('Saving capture')
    expect(operationHandle.fail).toHaveBeenCalled()
  })
})
