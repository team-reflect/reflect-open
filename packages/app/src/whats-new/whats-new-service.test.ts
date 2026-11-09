import { describe, expect, it } from 'vitest'
import { WritableStore, type GraphStatus } from '@reflect/core'
import {
  createTestGraphSessionService,
  createTestPlatformService,
  createTestStorageService,
} from '@reflect/core/testing'
import { createTestWindowService } from '../testing/window.ts'
import type { WhatsNewItem } from './whats-new-content.ts'
import {
  createWhatsNewService,
  decideWhatsNew,
  WHATS_NEW_SEEN_STORAGE_KEY,
  whatsNewPlatform,
  type WhatsNewInputs,
} from './whats-new-service.ts'

const ITEM_1: WhatsNewItem = { id: 'item-1', title: 'Item 1', body: 'One', platforms: ['ios'] }
const ITEM_2: WhatsNewItem = { id: 'item-2', title: 'Item 2', body: 'Two', platforms: ['darwin'] }
const ITEM_3: WhatsNewItem = {
  id: 'item-3',
  title: 'Item 3',
  body: 'Three',
  platforms: ['ios', 'darwin'],
}

const CONTENT: Readonly<Record<string, readonly WhatsNewItem[]>> = {
  '0.19.1': [ITEM_1, ITEM_2, ITEM_3],
}

const INPUTS: WhatsNewInputs = {
  isMainWindow: true,
  isDev: false,
  items: [ITEM_2],
  seen: false,
  override: false,
  blocked: false,
  graphOpened: true,
  offerFirst: false,
  accepted: false,
}

function decide(inputs: Partial<WhatsNewInputs>) {
  return decideWhatsNew({ ...INPUTS, ...inputs })
}

describe('decideWhatsNew', () => {
  it('shows an unseen version with items', () => {
    expect(decide({})).toBe('show')
  })

  it('waits outside the main window, until a graph opens, and while blocked, even with the override', () => {
    const cases: Partial<WhatsNewInputs>[] = [
      { isMainWindow: false },
      { graphOpened: false },
      { blocked: true },
    ]
    for (const inputs of cases) {
      expect(decide(inputs)).toBe('wait')
      expect(decide({ ...inputs, override: true })).toBe('wait')
    }
  })

  it('waits in a development build and after the version was seen', () => {
    expect(decide({ isDev: true })).toBe('wait')
    expect(decide({ seen: true })).toBe('wait')
  })

  it('shows with the override despite a development build or a seen version', () => {
    expect(decide({ override: true, isDev: true, seen: true })).toBe('show')
    expect(decide({ override: true, items: [] })).toBe('wait')
  })

  it('offers an unseen version first until the user accepts, but not with the override', () => {
    expect(decide({ offerFirst: true })).toBe('offer')
    expect(decide({ offerFirst: true, accepted: true })).toBe('show')
    expect(decide({ offerFirst: true, override: true })).toBe('show')
    expect(decide({ offerFirst: true, seen: true })).toBe('wait')
  })
})

interface SetupOptions {
  version?: string
  seen?: string
  buildPlatform?: 'darwin' | 'ios'
  status?: GraphStatus
  offerFirst?: boolean
}

function setup(options: SetupOptions = {}) {
  const storage = createTestStorageService()
  if (options.seen) {
    storage.local.set(WHATS_NEW_SEEN_STORAGE_KEY, options.seen)
  }
  const graphSession = createTestGraphSessionService({
    state: { status: options.status ?? 'ready' },
  })
  const whatsNew = createWhatsNewService({
    storage,
    platform: createTestPlatformService({
      buildPlatform: options.buildPlatform ?? 'darwin',
      appVersion: options.version ?? '0.19.1',
      isDev: false,
    }),
    window: createTestWindowService(),
    graphSession,
    blocked: new WritableStore(false),
    content: CONTENT,
    offerFirst: options.offerFirst ?? false,
  })
  const stop = whatsNew.start()
  const setStatus = (status: GraphStatus) => graphSession.setState({ status })
  const seen = () => storage.local.get(WHATS_NEW_SEEN_STORAGE_KEY)
  return { whatsNew, setStatus, seen, stop }
}

describe('createWhatsNewService', () => {
  it('shows the items for the platform once the graph opens, and hides once dismissed', () => {
    const { whatsNew, setStatus, seen } = setup({ seen: '["old-item"]', status: 'loading' })
    expect(whatsNew.phase.get()).toBe('hidden')
    setStatus('ready')
    expect(whatsNew.phase.get()).toBe('shown')
    expect(whatsNew.items).toEqual([ITEM_2, ITEM_3])

    whatsNew.dismiss()
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('["item-1","item-2","item-3"]')
  })

  it('shows only the items not seen yet', () => {
    const { whatsNew } = setup({ version: '0.19.1-beta.2', seen: '["item-2"]' })
    expect(whatsNew.phase.get()).toBe('shown')
    expect(whatsNew.items).toEqual([ITEM_3])
  })

  it('shows every item when the stored value is not a JSON array of strings', () => {
    for (const seen of ['0.19.1-beta.1', '{}', '[1]']) {
      const { whatsNew } = setup({ seen })
      expect(whatsNew.phase.get()).toBe('shown')
      expect(whatsNew.items).toEqual([ITEM_2, ITEM_3])
    }
  })

  it('stays hidden when every item was seen', () => {
    const { whatsNew } = setup({ seen: '["item-2","item-3"]' })
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(whatsNew.items).toEqual([ITEM_2, ITEM_3])
  })

  it('marks the version seen without showing after the graph chooser', () => {
    const { whatsNew, setStatus, seen } = setup({ status: 'loading' })
    setStatus('choosing')
    setStatus('ready')
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('["item-1","item-2","item-3"]')
  })

  it('ignores a graph switch after the first open', () => {
    const { whatsNew, setStatus, seen } = setup()
    setStatus('choosing')
    expect(whatsNew.phase.get()).toBe('shown')
    expect(seen()).toBeNull()
  })

  it('stays hidden for a version without items', () => {
    const { whatsNew } = setup({ version: '0.20.0' })
    expect(whatsNew.phase.get()).toBe('hidden')
  })

  it('shows seen items with the override, which dismiss turns off', () => {
    const { whatsNew } = setup({ seen: '["item-2","item-3"]' })
    expect(whatsNew.phase.get()).toBe('hidden')

    whatsNew.setOverride(true)
    expect(whatsNew.phase.get()).toBe('shown')

    whatsNew.dismiss()
    expect(whatsNew.override.get()).toBe(false)
    expect(whatsNew.phase.get()).toBe('hidden')
  })

  it('offers first, and shows once accepted without marking the version seen', () => {
    const { whatsNew, seen } = setup({ offerFirst: true })
    expect(whatsNew.phase.get()).toBe('offered')

    whatsNew.accept()
    expect(whatsNew.phase.get()).toBe('shown')
    whatsNew.decline()
    expect(seen()).toBeNull()
  })

  it('marks the version seen when the offer is declined', () => {
    const { whatsNew, seen } = setup({ offerFirst: true })
    whatsNew.decline()
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('["item-1","item-2","item-3"]')
  })

  it('stops following the launch', () => {
    const { whatsNew, setStatus, seen, stop } = setup({ status: 'loading' })
    stop()
    setStatus('choosing')
    setStatus('ready')
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBeNull()
  })
})

describe('whatsNewPlatform', () => {
  it('uses the build target', () => {
    expect(whatsNewPlatform(createTestPlatformService({ buildPlatform: 'windows' }))).toBe(
      'windows',
    )
  })

  it('stands in a build target in browser dev', () => {
    const platform = (options: Parameters<typeof createTestPlatformService>[0]) => {
      return whatsNewPlatform({ ...createTestPlatformService(options), buildPlatform: null })
    }
    expect(platform({ appPlatform: 'ios' })).toBe('ios')
    expect(platform({ appPlatform: 'desktop', isApplePlatform: true })).toBe('darwin')
    expect(platform({ appPlatform: 'desktop', isApplePlatform: false })).toBe('windows')
  })
})
