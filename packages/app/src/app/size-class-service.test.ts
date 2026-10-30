import { describe, expect, it, vi } from 'vitest'
import {
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestPlatformService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { createSizeClassService } from './size-class-service.ts'

const IPAD: TestPlatformOptions = {
  appPlatform: 'ios',
  isMacosDesktop: false,
  isTablet: true,
  surface: { mobileApp: true, touchEditor: true },
}

interface FakeQuery {
  matches: boolean
  listeners: Set<() => void>
}

function fakeMedia(matches: boolean) {
  const query: FakeQuery = { matches, listeners: new Set() }
  const matchMedia = (): MediaQueryList => {
    return {
      get matches() {
        return query.matches
      },
      addEventListener: (_type: string, listener: () => void) => query.listeners.add(listener),
    } as unknown as MediaQueryList
  }
  const resize = (next: boolean): void => {
    query.matches = next
    for (const listener of query.listeners) {
      listener()
    }
  }
  return { media: { matchMedia }, resize }
}

function setup(options: { platform?: TestPlatformOptions; pluginEvents?: boolean } = {}) {
  const ipc = createTestIpcBridgeService({ pluginEvents: options.pluginEvents ?? true })
  const logger = createTestLoggerService()
  const platform = createTestPlatformService(options.platform ?? IPAD)
  const { media, resize } = fakeMedia(true)
  const sizeClass = createSizeClassService({ ipc, platform, logger, media })
  return { ipc, logger, sizeClass, resize }
}

describe('SizeClassService', () => {
  it('is always regular on the desktop app and always compact on a phone', () => {
    const desktop = setup({ platform: {} }).sizeClass
    desktop.start()
    expect(desktop.current()).toBe('regular')

    const phone = setup({ platform: { ...IPAD, isTablet: false } }).sizeClass
    phone.start()
    expect(phone.current()).toBe('compact')
  })

  it('on an iPad, is unknown until the scene plugin answers', async () => {
    const { ipc, sizeClass } = setup()
    ipc.onCommand('plugin:scene|size_class', () => ({ horizontal: 'regular' }))
    expect(sizeClass.current()).toBeNull()

    sizeClass.start()
    await vi.waitFor(() => {
      expect(sizeClass.current()).toBe('regular')
    })
  })

  it('follows the scene plugin as the window crosses between widths', async () => {
    const { ipc, sizeClass } = setup()
    ipc.onCommand('plugin:scene|size_class', () => ({ horizontal: 'regular' }))
    const listener = vi.fn()
    sizeClass.subscribe(listener)
    sizeClass.start()
    await vi.waitFor(() => {
      expect(sizeClass.current()).toBe('regular')
    })

    ipc.emitPlugin('scene', 'sizeClassChanged', { horizontal: 'compact' })
    expect(sizeClass.current()).toBe('compact')
    // An unchanged class notifies nobody.
    ipc.emitPlugin('scene', 'sizeClassChanged', { horizontal: 'compact' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps a change that lands while the first read is in flight', async () => {
    const { ipc, sizeClass } = setup()
    ipc.onCommand('plugin:scene|size_class', () => {
      ipc.emitPlugin('scene', 'sizeClassChanged', { horizontal: 'compact' })
      return { horizontal: 'regular' }
    })
    sizeClass.start()
    await vi.waitFor(() => {
      expect(ipc.calls()).toHaveLength(1)
    })
    await Promise.resolve()
    expect(sizeClass.current()).toBe('compact')
  })

  it('falls back to the window width when the scene plugin is missing', async () => {
    const { sizeClass, logger, resize } = setup({ pluginEvents: false })
    sizeClass.start()
    await vi.waitFor(() => {
      expect(sizeClass.current()).toBe('regular')
    })
    expect(logger.getWarnings().map((entry) => entry.message)).toEqual([
      'the scene plugin is unavailable; following the window width instead',
    ])

    resize(false)
    expect(sizeClass.current()).toBe('compact')
  })

  it('follows the window width in plain-browser dev', () => {
    const { ipc, sizeClass, resize } = setup({ platform: { ...IPAD, isNativeShell: false } })
    sizeClass.start()
    expect(sizeClass.current()).toBe('regular')
    resize(false)
    expect(sizeClass.current()).toBe('compact')
    expect(ipc.calls()).toEqual([])
  })
})
