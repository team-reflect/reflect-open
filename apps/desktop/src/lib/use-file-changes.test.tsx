import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { FileChange } from '@reflect/core'
import { useFileChanges } from './use-file-changes'

const subscribeFileChanges = vi.hoisted(() => vi.fn())
const hasBridge = vi.hoisted(() => vi.fn(() => true))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge,
  subscribeFileChanges,
}))

interface Subscription {
  emit: (changes: FileChange[]) => void
  unlisten: ReturnType<typeof vi.fn>
  resolve: () => Promise<void>
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Capture the watcher callback and hand back a controllable unlisten. */
function stubSubscription(): Subscription {
  let listener: ((changes: FileChange[]) => void) | null = null
  const unlisten = vi.fn()
  let resolveSubscribe: (stop: () => void) => void = () => {}
  subscribeFileChanges.mockImplementation((callback: (changes: FileChange[]) => void) => {
    listener = callback
    return new Promise<() => void>((promiseResolve) => {
      resolveSubscribe = promiseResolve
    })
  })
  return {
    emit: (changes) => listener?.(changes),
    unlisten,
    resolve: async () => {
      resolveSubscribe(unlisten)
      await flushMicrotasks()
    },
  }
}

function Host({ handler }: { handler: ((changes: FileChange[]) => void) | null }): null {
  useFileChanges(handler)
  return null
}

const UPSERT: FileChange[] = [{ path: 'notes/a.md', kind: 'upsert' }]

beforeEach(() => {
  subscribeFileChanges.mockReset()
  hasBridge.mockReturnValue(true)
})

describe('useFileChanges', () => {
  it('delivers watcher events to the handler', async () => {
    const subscription = stubSubscription()
    const handler = vi.fn()
    const view = await render(<Host handler={handler} />)
    await subscription.resolve()
    subscription.emit(UPSERT)
    expect(handler).toHaveBeenCalledWith(UPSERT)
    await view.unmount()
  })

  it('drops events that race the teardown', async () => {
    const subscription = stubSubscription()
    const handler = vi.fn()
    const view = await render(<Host handler={handler} />)
    await subscription.resolve()
    await view.unmount()
    subscription.emit(UPSERT)
    expect(handler).not.toHaveBeenCalled()
    expect(subscription.unlisten).toHaveBeenCalledOnce()
  })

  it('closes an unlisten that resolves after teardown', async () => {
    const subscription = stubSubscription()
    const view = await render(<Host handler={vi.fn()} />)
    await view.unmount()
    await subscription.resolve()
    expect(subscription.unlisten).toHaveBeenCalledOnce()
  })

  it('resubscribes when the handler identity changes', async () => {
    const first = stubSubscription()
    const view = await render(<Host handler={vi.fn()} />)
    await first.resolve()
    expect(subscribeFileChanges).toHaveBeenCalledTimes(1)

    const second = stubSubscription()
    const nextHandler = vi.fn()
    await view.rerender(<Host handler={nextHandler} />)
    await second.resolve()
    expect(subscribeFileChanges).toHaveBeenCalledTimes(2)
    expect(first.unlisten).toHaveBeenCalledOnce()

    second.emit(UPSERT)
    expect(nextHandler).toHaveBeenCalledWith(UPSERT)
    await view.unmount()
  })

  it('does nothing when disabled or without a bridge', async () => {
    const view = await render(<Host handler={null} />)
    expect(subscribeFileChanges).not.toHaveBeenCalled()
    await view.unmount()

    hasBridge.mockReturnValue(false)
    const bridgeless = await render(<Host handler={vi.fn()} />)
    expect(subscribeFileChanges).not.toHaveBeenCalled()
    await bridgeless.unmount()
  })

  // The hook doesn't catch handler throws (the contract only covers the
  // subscription lifecycle), so only the rejected-subscription path is tested.
  it('logs and stays inert when the subscription itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeFileChanges.mockRejectedValue(new Error('bridge gone'))
    const handler = vi.fn()
    const view = await render(<Host handler={handler} />)
    await flushMicrotasks()

    expect(consoleError).toHaveBeenCalledWith(
      'file-change subscription failed:',
      expect.any(Error),
    )
    expect(handler).not.toHaveBeenCalled()
    await expect(view.unmount()).resolves.toBeUndefined()
    consoleError.mockRestore()
  })
})
