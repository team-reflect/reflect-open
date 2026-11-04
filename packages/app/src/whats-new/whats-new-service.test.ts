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
  type WhatsNewInputs,
} from './whats-new-service.ts'

const ITEM_1: WhatsNewItem = { title: 'Item 1', body: 'One', platforms: ['ios'] }
const ITEM_2: WhatsNewItem = { title: 'Item 2', body: 'Two', platforms: ['desktop'] }
const ITEM_3: WhatsNewItem = { title: 'Item 3', body: 'Three', platforms: ['ios', 'desktop'] }

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
  launch: 'opened',
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
      { launch: 'opening' },
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

  it('skips a version without items and the version of a new install', () => {
    expect(decide({ items: [] })).toBe('skip')
    expect(decide({ launch: 'openedAfterSetup' })).toBe('skip')
  })

  it('shows with the override despite a development build, a seen version, or a new install', () => {
    expect(decide({ override: true, isDev: true, seen: true, launch: 'openedAfterSetup' })).toBe(
      'show',
    )
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
  appPlatform?: 'desktop' | 'ios'
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
      appPlatform: options.appPlatform ?? 'desktop',
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
    const { whatsNew, setStatus, seen } = setup({ seen: '0.19.0', status: 'loading' })
    expect(whatsNew.phase.get()).toBe('hidden')
    setStatus('ready')
    expect(whatsNew.phase.get()).toBe('shown')
    expect(whatsNew.items).toEqual([ITEM_2, ITEM_3])

    whatsNew.dismiss()
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('0.19.1')
  })

  it('shows every item of a beta so far, once per full version', () => {
    const beta = setup({ appPlatform: 'ios', version: '0.19.1-beta.2', seen: '0.19.1-beta.1' })
    expect(beta.whatsNew.phase.get()).toBe('shown')
    expect(beta.whatsNew.items).toEqual([ITEM_1, ITEM_3])
    const stable = setup({ appPlatform: 'ios', seen: '0.19.1-beta.2' })
    expect(stable.whatsNew.phase.get()).toBe('shown')
  })

  it('marks the version seen without showing after the graph chooser', () => {
    const { whatsNew, setStatus, seen } = setup({ status: 'loading' })
    setStatus('choosing')
    setStatus('ready')
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('0.19.1')
  })

  it('ignores a graph switch after the first open', () => {
    const { whatsNew, setStatus, seen } = setup({ seen: '0.19.0' })
    setStatus('choosing')
    expect(whatsNew.phase.get()).toBe('shown')
    expect(seen()).toBe('0.19.0')
  })

  it('marks a version without items seen at start', () => {
    const { whatsNew, seen } = setup({ version: '0.20.0', seen: '0.19.1' })
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('0.20.0')
  })

  it('shows a seen version with the override, which dismiss turns off', () => {
    const { whatsNew } = setup({ seen: '0.19.1' })
    expect(whatsNew.phase.get()).toBe('hidden')

    whatsNew.setOverride(true)
    expect(whatsNew.phase.get()).toBe('shown')

    whatsNew.dismiss()
    expect(whatsNew.override.get()).toBe(false)
    expect(whatsNew.phase.get()).toBe('hidden')
  })

  it('offers first, and shows once accepted without marking the version seen', () => {
    const { whatsNew, seen } = setup({ seen: '0.19.0', offerFirst: true })
    expect(whatsNew.phase.get()).toBe('offered')

    whatsNew.accept()
    expect(whatsNew.phase.get()).toBe('shown')
    whatsNew.decline()
    expect(seen()).toBe('0.19.0')
  })

  it('marks the version seen when the offer is declined', () => {
    const { whatsNew, seen } = setup({ seen: '0.19.0', offerFirst: true })
    whatsNew.decline()
    expect(whatsNew.phase.get()).toBe('hidden')
    expect(seen()).toBe('0.19.1')
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
