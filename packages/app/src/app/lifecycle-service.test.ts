import { describe, expect, it, vi } from 'vitest'
import {
  createTestClockService,
  createTestIpcBridgeService,
  createTestLoggerService,
} from '@reflect/core/testing'
import {
  createLifecycleService,
  RESUME_THROTTLE_MS,
  type LifecycleDomAdapter,
  type LifecyclePageEvent,
} from './lifecycle-service.ts'

function createFakeDom() {
  const pageListeners = new Map<LifecyclePageEvent, Set<() => void>>()
  const visibilityListeners = new Set<() => void>()
  let hidden = false
  const dom: LifecycleDomAdapter = {
    onPageEvent(type, listener) {
      const listeners = pageListeners.get(type) ?? new Set()
      pageListeners.set(type, listeners)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onVisibilityChange(listener) {
      visibilityListeners.add(listener)
      return () => {
        visibilityListeners.delete(listener)
      }
    },
    isHidden: () => hidden,
  }
  return {
    dom,
    dispatch(type: LifecyclePageEvent) {
      for (const listener of pageListeners.get(type) ?? []) {
        listener()
      }
    },
    setVisibility(next: 'visible' | 'hidden') {
      hidden = next === 'hidden'
      for (const listener of visibilityListeners) {
        listener()
      }
    },
    listenerCount() {
      let count = visibilityListeners.size
      for (const listeners of pageListeners.values()) {
        count += listeners.size
      }
      return count
    },
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve()
  }
}

function setup() {
  const fake = createFakeDom()
  const clock = createTestClockService({ now: 1_000_000 })
  const ipc = createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const lifecycle = createLifecycleService({ ipc, dom: fake.dom, clock, logger })
  return { lifecycle, fake, clock, ipc, logger }
}

describe('subscribeResume', () => {
  it('calls back at once, then once more for the burst that follows', async () => {
    const { lifecycle, fake, clock } = setup()
    const onResume = vi.fn()
    lifecycle.subscribeResume(onResume)

    fake.dispatch('focus')
    expect(onResume).toHaveBeenCalledTimes(1)
    fake.dispatch('online')
    fake.setVisibility('visible')
    expect(onResume).toHaveBeenCalledTimes(1)

    await clock.advance(RESUME_THROTTLE_MS)
    expect(onResume).toHaveBeenCalledTimes(2)
  })

  it('ignores the page turning hidden', () => {
    const { lifecycle, fake } = setup()
    const onResume = vi.fn()
    lifecycle.subscribeResume(onResume)

    fake.setVisibility('hidden')

    expect(onResume).not.toHaveBeenCalled()
  })

  it('stops calling back after dispose, even with a call still pending', async () => {
    const { lifecycle, fake, clock } = setup()
    const onResume = vi.fn()
    const dispose = lifecycle.subscribeResume(onResume)
    fake.dispatch('focus')
    fake.dispatch('online')
    onResume.mockClear()

    dispose()
    await clock.advance(RESUME_THROTTLE_MS)
    fake.dispatch('focus')

    expect(onResume).not.toHaveBeenCalled()
    expect(fake.listenerCount()).toBe(0)
    expect(clock.pendingTimers()).toBe(0)
  })
})

describe('page signals', () => {
  it('reports wake, visibility, pagehide, and beforeunload to their subscribers', () => {
    const { lifecycle, fake } = setup()
    const wake = vi.fn()
    const focus = vi.fn()
    const visible = vi.fn()
    const hidden = vi.fn()
    const pageHide = vi.fn()
    const beforeUnload = vi.fn()
    const disposers = [
      lifecycle.subscribeWake(wake),
      lifecycle.subscribeFocus(focus),
      lifecycle.subscribeVisible(visible),
      lifecycle.subscribeHidden(hidden),
      lifecycle.subscribePageHide(pageHide),
      lifecycle.subscribeBeforeUnload(beforeUnload),
    ]

    fake.dispatch('focus')
    fake.dispatch('online')
    fake.setVisibility('hidden')
    expect(lifecycle.isHidden()).toBe(true)
    fake.setVisibility('visible')
    expect(lifecycle.isHidden()).toBe(false)
    fake.dispatch('pagehide')
    fake.dispatch('beforeunload')

    expect(wake).toHaveBeenCalledTimes(2)
    expect(focus).toHaveBeenCalledOnce()
    expect(hidden).toHaveBeenCalledOnce()
    expect(visible).toHaveBeenCalledOnce()
    expect(pageHide).toHaveBeenCalledOnce()
    expect(beforeUnload).toHaveBeenCalledOnce()

    for (const dispose of disposers) {
      dispose()
    }
    expect(fake.listenerCount()).toBe(0)
  })
})

describe('shell handshakes', () => {
  it('delivers deferred quits and confirms them', async () => {
    const { lifecycle, ipc } = setup()
    ipc.onCommand('quit_confirm', () => null)
    const quitRequested = vi.fn()
    const unlisten = lifecycle.subscribeQuitRequested(quitRequested)
    await settle()
    ipc.emit('app:quit-requested', null)
    unlisten()
    ipc.emit('app:quit-requested', null)

    await lifecycle.confirmQuit()

    expect(quitRequested).toHaveBeenCalledOnce()
    expect(ipc.calls().map((call) => call.command)).toEqual(['quit_confirm'])
  })

  it('begins and ends background tasks', async () => {
    const { lifecycle, ipc } = setup()
    ipc.onCommand('background_task_begin', () => 'task-1')
    ipc.onCommand('background_task_end', () => null)

    const token = await lifecycle.beginBackgroundTask()
    expect(token).toBe('task-1')
    await lifecycle.endBackgroundTask('task-1')

    expect(ipc.calls()).toEqual([
      { command: 'background_task_begin', args: {} },
      { command: 'background_task_end', args: { token: 'task-1' } },
    ])
  })

  it('answers null when the shell has no background task', async () => {
    const { lifecycle, ipc } = setup()
    ipc.onCommand('background_task_begin', () => null)
    await expect(lifecycle.beginBackgroundTask()).resolves.toBeNull()
  })
})
