import { describe, expect, it, vi } from 'vitest'
import type { NoteSession } from '@/editor/note-session'
import { createNotePathOperationQueue, routeNoteOperation } from './note-mutation-routing'

describe('routeNoteOperation', () => {
  it('uses the open session as the authority and never falls through after a refusal', async () => {
    const session = {} as NoteSession
    const closed = vi.fn(async () => 'closed')

    await expect(
      routeNoteOperation('notes/a.md', { open: async () => 'refused', closed }, () => session),
    ).resolves.toBe('refused')
    expect(closed).not.toHaveBeenCalled()
  })

  it('routes to the closed-note operation when no editor owns the path', async () => {
    await expect(
      routeNoteOperation(
        'notes/a.md',
        { open: async () => 'open', closed: async () => 'closed' },
        () => null,
      ),
    ).resolves.toBe('closed')
  })
})

describe('createNotePathOperationQueue', () => {
  it('serializes the same path and continues after a rejected operation', async () => {
    const queue = createNotePathOperationQueue()
    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    const first = queue.run('notes/a.md', async () => {
      events.push('first:start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      events.push('first:end')
      throw new Error('failed')
    })
    const second = queue.run('notes/a.md', async () => {
      events.push('second')
      return 'done'
    })

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
    expect(events).toEqual(['first:start'])
    releaseFirst?.()
    await expect(first).rejects.toThrow('failed')
    await expect(second).resolves.toBe('done')
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('does not block a different path', async () => {
    const queue = createNotePathOperationQueue()
    let releaseFirst: (() => void) | undefined
    const first = queue.run('notes/a.md', async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    })

    await expect(queue.run('notes/b.md', async () => 'done')).resolves.toBe('done')
    releaseFirst?.()
    await first
  })
})
