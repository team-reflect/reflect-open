import { describe, expect, it } from 'vitest'
import { createTestOperationsService } from '../testing/operations.ts'
import { LINGER_MS, MIN_VISIBLE_MS } from './operations-service.ts'

describe('createOperationsService', () => {
  it('tracks start, progress, and done', async () => {
    const operations = createTestOperationsService()
    expect(operations.getAll()).toEqual([])

    const handle = operations.start('Renaming "A" to "B"')
    expect(operations.getAll()).toHaveLength(1)
    expect(operations.getAll()[0]!.label).toBe('Renaming "A" to "B"')
    expect(operations.getAll()[0]!.progress).toBeNull()

    handle.progress(3, 12)
    expect(operations.getAll()[0]!.progress).toEqual({ done: 3, total: 12 })

    handle.done()
    expect(operations.getAll()).toHaveLength(1)
    await operations.clock.advance(MIN_VISIBLE_MS - 1)
    expect(operations.getAll()).toHaveLength(1)
    await operations.clock.advance(1)
    expect(operations.getAll()).toEqual([])
  })

  it('removes a finished operation at once after the minimum visible time', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('slow')
    await operations.clock.advance(MIN_VISIBLE_MS)
    handle.done()
    expect(operations.getAll()).toEqual([])
    expect(operations.clock.pendingTimers()).toBe(0)
  })

  it('keeps a failed operation with its error, then clears it', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('Renaming')
    handle.fail('disk full')
    expect(operations.findByLabel('Renaming')).toMatchObject({
      status: 'failed',
      message: 'disk full',
    })

    await operations.clock.advance(LINGER_MS + MIN_VISIBLE_MS - 1)
    expect(operations.getAll()).toHaveLength(1)
    await operations.clock.advance(1)
    expect(operations.getAll()).toEqual([])
  })

  it('keeps a warning operation without marking it failed', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('Rebuilding search index')
    handle.warn('Rebuilt with 1 skipped note: notes/bad.md')
    expect(operations.snapshot()).toEqual([
      {
        label: 'Rebuilding search index',
        description: null,
        progress: null,
        status: 'warning',
        persistent: false,
        action: null,
        message: 'Rebuilt with 1 skipped note: notes/bad.md',
      },
    ])

    await operations.clock.advance(LINGER_MS + MIN_VISIBLE_MS)
    expect(operations.getAll()).toEqual([])
  })

  it('scopes handles: finishing one operation leaves others running', async () => {
    const operations = createTestOperationsService()
    const first = operations.start('first')
    operations.start('second')
    first.done()
    await operations.clock.advance(MIN_VISIBLE_MS)
    expect(operations.getAll().map((operation) => operation.label)).toEqual(['second'])
  })

  it('stores optional metadata and can dismiss immediately', async () => {
    const operations = createTestOperationsService()
    const action = { label: 'Install', run: () => {} }
    const handle = operations.start('Install update', {
      description: 'Reflect 1.2.3 is ready.',
      persistent: true,
      action,
    })
    expect(operations.getAll()[0]).toMatchObject({
      label: 'Install update',
      description: 'Reflect 1.2.3 is ready.',
      persistent: true,
      action,
    })

    await operations.clock.advance(30_000)
    expect(operations.getAll()).toHaveLength(1)

    handle.dismiss()
    expect(operations.getAll()).toEqual([])
  })

  it('keeps persistent failures visible until dismissed by id', async () => {
    const operations = createTestOperationsService()
    const handle = operations.start('Install update', { persistent: true })
    handle.fail('signature failed')
    await operations.clock.advance(30_000)
    const failed = operations.findByLabel('Install update')
    expect(failed).toMatchObject({ status: 'failed', message: 'signature failed' })

    operations.dismiss(failed!.id)
    expect(operations.getAll()).toEqual([])
  })

  it('notifies listeners on every change until they unsubscribe', () => {
    const operations = createTestOperationsService()
    let calls = 0
    const unlisten = operations.subscribe(() => {
      calls++
    })
    const handle = operations.start('job')
    handle.progress(1, 2)
    expect(calls).toBe(2)
    const before = operations.getAll()
    unlisten()
    handle.dismiss()
    expect(calls).toBe(2)
    expect(operations.getAll()).not.toBe(before)
  })

  it('ignores changes to an operation that is gone', () => {
    const operations = createTestOperationsService()
    const handle = operations.start('job')
    handle.dismiss()
    let calls = 0
    operations.subscribe(() => {
      calls++
    })
    handle.progress(1, 2)
    operations.dismiss(999)
    expect(calls).toBe(0)
  })
})
