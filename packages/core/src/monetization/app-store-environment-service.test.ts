import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestPlatformService } from '../testing/platform.ts'
import { createTestAppStoreService } from '../testing/plugins.ts'
import { createTestStorageService, type TestStorageService } from '../testing/storage.ts'
import {
  APP_STORE_ENVIRONMENT_STORAGE_KEY,
  createAppStoreEnvironmentService,
  type AppStoreEnvironmentService,
} from './app-store-environment-service.ts'

let storage: TestStorageService
/**
 * What the install-channel probe answers, or how it fails to.
 */
let probe: () => Promise<string>
let probes: number

beforeEach(() => {
  storage = createTestStorageService()
  probe = () => Promise.resolve('Production')
  probes = 0
})

function service(appPlatform: 'ios' | 'desktop' = 'ios'): AppStoreEnvironmentService {
  const appStore = createTestAppStoreService()
  vi.spyOn(appStore, 'environment').mockImplementation(() => {
    probes += 1
    return probe()
  })
  return createAppStoreEnvironmentService({
    appStore,
    storage,
    platform: createTestPlatformService({ appPlatform }),
  })
}

function remembered(): string | null {
  return storage.local.get(APP_STORE_ENVIRONMENT_STORAGE_KEY)
}

describe('AppStoreEnvironmentService', () => {
  it('names the channel the probe reports', async () => {
    probe = () => Promise.resolve('Xcode')
    const environment = service()
    expect(environment.get()).toEqual({ value: null, isLoading: true, isError: false })

    await expect(environment.environment()).resolves.toBe('Xcode')
    expect(environment.get()).toEqual({ value: 'Xcode', isLoading: false, isError: false })
  })

  it('reads an unrecognized channel as unknown', async () => {
    probe = () => Promise.resolve('Moon')
    await expect(service().environment()).resolves.toBeNull()
  })

  it('reports a failed probe and keeps the value', async () => {
    probe = () => Promise.reject(new Error('no app transaction'))
    const environment = service()

    await expect(environment.environment()).resolves.toBeNull()
    expect(environment.get()).toEqual({ value: null, isLoading: false, isError: true })
  })

  it('retries a failed probe once', async () => {
    probe = () => {
      return probes === 1
        ? Promise.reject(new Error('no app transaction'))
        : Promise.resolve('Xcode')
    }
    const environment = service()

    await expect(environment.environment()).resolves.toBe('Xcode')
    expect(probes).toBe(2)
    expect(environment.get()).toEqual({ value: 'Xcode', isLoading: false, isError: false })
  })

  it('probes once per launch', async () => {
    const environment = service()
    await environment.environment()
    await environment.environment()
    expect(probes).toBe(1)
  })

  it('shares one probe between overlapping calls', async () => {
    const environment = service()
    await Promise.all([environment.environment(), environment.environment()])
    expect(probes).toBe(1)
  })

  it('answers from a remembered Sandbox before the probe says anything', async () => {
    probe = () => Promise.resolve('Sandbox')
    await service().environment()
    expect(remembered()).toBe(JSON.stringify('Sandbox'))

    probe = () => new Promise(() => {})
    expect(service().get()).toEqual({ value: 'Sandbox', isLoading: false, isError: false })
  })

  it('keeps a remembered channel when the live probe fails', async () => {
    probe = () => Promise.resolve('Sandbox')
    await service().environment()

    probe = () => Promise.reject(new Error('no app transaction'))
    const environment = service()
    await environment.environment()
    expect(environment.get()).toEqual({ value: 'Sandbox', isLoading: false, isError: true })
  })

  it('corrects a remembered Sandbox once the build reaches the App Store', async () => {
    probe = () => Promise.resolve('Sandbox')
    await service().environment()

    probe = () => Promise.resolve('Production')
    const environment = service()
    await environment.environment()
    expect(environment.get().value).toBe('Production')
    expect(remembered()).toBeNull()
  })

  it('drops a remembered channel the probe no longer recognizes', async () => {
    probe = () => Promise.resolve('Sandbox')
    await service().environment()
    probe = () => Promise.resolve('Moon')
    await service().environment()

    expect(remembered()).toBeNull()
    expect(service().get().value).toBeNull()
  })

  it('does not answer from a channel an older build remembered as Production', () => {
    storage.local.set(APP_STORE_ENVIRONMENT_STORAGE_KEY, JSON.stringify('Production'))
    expect(service().get().value).toBeNull()
  })

  it('probes again after `invalidate` while subscribed', async () => {
    const environment = service()
    await environment.environment()
    environment.subscribe(() => {})

    probe = () => Promise.resolve('Sandbox')
    environment.invalidate()
    await Promise.resolve()
    await Promise.resolve()

    expect(probes).toBe(2)
    await expect(environment.environment()).resolves.toBe('Sandbox')
  })

  it('keeps the state reference and stays quiet when a probe repeats the answer', async () => {
    const environment = service()
    await environment.environment()
    const state = environment.get()
    const listener = vi.fn()
    environment.subscribe(listener)

    environment.invalidate()
    await environment.environment()

    expect(probes).toBe(2)
    expect(environment.get()).toBe(state)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops probing on `invalidate` once the last subscriber leaves', async () => {
    const environment = service()
    await environment.environment()
    const unsubscribe = environment.subscribe(() => {})

    unsubscribe()
    unsubscribe()
    environment.invalidate()

    expect(probes).toBe(1)
  })

  it('stays out of the way off iOS', async () => {
    storage.local.set(APP_STORE_ENVIRONMENT_STORAGE_KEY, JSON.stringify('Sandbox'))
    const environment = service('desktop')
    expect(environment.get()).toEqual({ value: null, isLoading: false, isError: false })
    await expect(environment.environment()).resolves.toBeNull()
    expect(probes).toBe(0)
  })
})
