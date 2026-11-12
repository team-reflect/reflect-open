import { createTestClockService } from '@reflect/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { createTestNativeChromeHost } from '../testing/native-chrome.ts'
import { createNativeChromeService } from './native-chrome-service.ts'

describe('NativeChromeService', () => {
  it('is disabled without a host and posts nothing', () => {
    const chrome = createNativeChromeService({ host: undefined, clock: createTestClockService() })
    expect(chrome.enabled).toBe(false)
    chrome.post({ type: 'chromeReady' })
    chrome.postState({ type: 'state' })
  })

  it('numbers each new state and drops an unchanged one', () => {
    const host = createTestNativeChromeHost()
    const chrome = createNativeChromeService({ host, clock: createTestClockService({ now: 1000 }) })
    chrome.postState({ type: 'state', title: 'A' })
    chrome.postState({ type: 'state', title: 'A' })
    chrome.postState({ type: 'state', title: 'B' })
    expect(host.posted).toEqual([
      { type: 'state', title: 'A', generation: 1001 },
      { type: 'state', title: 'B', generation: 1002 },
    ])
  })

  it('gives intents to the latest listener and drops them without one', () => {
    const host = createTestNativeChromeHost()
    const chrome = createNativeChromeService({ host, clock: createTestClockService() })
    const first = vi.fn()
    const second = vi.fn()
    const unlistenFirst = chrome.listenIntent(first)
    const unlistenSecond = chrome.listenIntent(second)
    host.sendIntent('tab')
    unlistenFirst()
    host.sendIntent('back')
    unlistenSecond()
    host.sendIntent('lost')
    expect(first).not.toHaveBeenCalled()
    expect(second.mock.calls).toEqual([['tab'], ['back']])
  })
})
