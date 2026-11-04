import { describe, expect, it } from 'vitest'
import { WritableStore } from '@reflect/core'
import {
  createTestGraphSessionService,
  createTestLoggerService,
  createTestPlatformService,
  createTestStorageService,
} from '@reflect/core/testing'
import { createTestOperationsService } from '../testing/operations.ts'
import { createTestToastService } from '../testing/toast.ts'
import { createTestUpdateService } from '../testing/update.ts'
import { createTestWindowService } from '../testing/window.ts'
import {
  createWhatsNewService,
  WHATS_NEW_SEEN_STORAGE_KEY,
} from '../whats-new/whats-new-service.ts'
import { syncDesktopToasts } from './desktop-toasts.ts'

function setup() {
  const storage = createTestStorageService()
  storage.local.set(WHATS_NEW_SEEN_STORAGE_KEY, '0.19.0')
  const platform = createTestPlatformService({
    appPlatform: 'desktop',
    appVersion: '0.19.1',
    isDev: false,
  })
  const whatsNew = createWhatsNewService({
    storage,
    platform,
    window: createTestWindowService(),
    graphSession: createTestGraphSessionService({ state: { status: 'ready' } }),
    blocked: new WritableStore(false),
    content: { '0.19.1': [{ title: 'Item', body: 'Body', platforms: ['desktop'] }] },
    offerFirst: true,
  })
  whatsNew.start()
  const toasts = createTestToastService()
  const update = createTestUpdateService()
  const operations = createTestOperationsService()
  const stop = syncDesktopToasts({
    toasts,
    update,
    operations,
    whatsNew,
    platform,
    logger: createTestLoggerService(),
  })
  const ids = () => toasts.open().map((toast) => toast.id)
  const seen = () => storage.local.get(WHATS_NEW_SEEN_STORAGE_KEY)
  return { toasts, update, operations, whatsNew, stop, ids, seen }
}

describe('syncDesktopToasts', () => {
  it('shows a toast for each source and closes it when its state goes away', async () => {
    const { update, operations, ids } = setup()
    expect(ids()).toEqual(['reflect-whats-new'])

    update.setState({ phase: 'available', version: '0.20.0' })
    const handle = operations.start('Saving settings')
    expect(ids()).toEqual(['reflect-whats-new', 'reflect-update', 'operation-1'])

    update.setState({ phase: 'idle' })
    handle.fail('disk full')
    await operations.clock.advance(9_200)
    expect(ids()).toEqual(['reflect-whats-new'])
  })

  it('opens What’s New from the toast without marking the version seen', () => {
    const { toasts, whatsNew, ids, seen } = setup()

    toasts.open()[0]?.action?.run()
    expect(whatsNew.phase.get()).toBe('shown')
    expect(ids()).toEqual([])
    expect(seen()).toBe('0.19.0')
  })

  it('marks the version seen when the What’s New toast closes any other way', () => {
    const { toasts, whatsNew, seen } = setup()

    toasts.close('reflect-whats-new')
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('0.19.1')
  })

  it('stops following the sources and leaves the open toasts open', () => {
    const { update, stop, ids } = setup()

    stop()
    update.setState({ phase: 'available', version: '0.20.0' })
    expect(ids()).toEqual(['reflect-whats-new'])
  })
})
