import { describe, expect, it } from 'vitest'
import { WritableStore, type GraphStatus } from '@reflect/core'
import {
  createTestActivityPort,
  createTestDeepLinkIntakeService,
  createTestPlatformService,
  createTestStorageService,
} from '@reflect/core/testing'
import { createTestWindowService } from '../testing/window.ts'
import type { WhatsNewItem } from './whats-new-content.ts'
import {
  createWhatsNewService,
  decideWhatsNew,
  WHATS_NEW_OVERRIDE_STORAGE_KEY,
  WHATS_NEW_SEEN_STORAGE_KEY,
  type WhatsNewBlocker,
  type WhatsNewInputs,
} from './whats-new-service.ts'

const ITEM_1: WhatsNewItem = { title: 'Item 1', body: 'One', platforms: ['ios'] }
const ITEM_2: WhatsNewItem = { title: 'Item 2', body: 'Two', platforms: ['desktop'] }
const ITEM_3: WhatsNewItem = { title: 'Item 3', body: 'Three', platforms: ['ios', 'desktop'] }

const CONTENT: Readonly<Record<string, readonly WhatsNewItem[]>> = {
  '0.19.1': [ITEM_1, ITEM_2, ITEM_3],
  '0.19.0': [ITEM_2],
}

const INPUTS: WhatsNewInputs = {
  isMainWindow: true,
  isDev: false,
  platform: 'desktop',
  version: '0.19.1',
  seen: '0.19.0',
  override: false,
  blocker: 'clear',
  graphOpened: true,
  setupSeen: false,
  deepLinkSeen: false,
}

function decide(inputs: Partial<WhatsNewInputs>, content = CONTENT) {
  return decideWhatsNew({ ...INPUTS, ...inputs }, content)
}

describe('decideWhatsNew', () => {
  it('shows the items of the marketing version for the platform', () => {
    expect(decide({})).toEqual({ kind: 'show', items: [ITEM_2, ITEM_3] })
    expect(decide({ platform: 'ios' })).toEqual({ kind: 'show', items: [ITEM_1, ITEM_3] })
  })

  it('shows every item of a beta so far, once per full version', () => {
    const content = { '0.19.1': [ITEM_3, ITEM_1] }
    const beta1 = { '0.19.1': [ITEM_3] }
    const platform = 'ios'
    expect(decide({ platform, version: '0.19.1-beta.1', seen: '0.19.0' }, beta1)).toEqual({
      kind: 'show',
      items: [ITEM_3],
    })
    expect(decide({ platform, version: '0.19.1-beta.2', seen: '0.19.1-beta.1' }, content)).toEqual({
      kind: 'show',
      items: [ITEM_3, ITEM_1],
    })
    expect(decide({ platform, version: '0.19.1', seen: '0.19.1-beta.2' }, content)).toEqual({
      kind: 'show',
      items: [ITEM_3, ITEM_1],
    })
    expect(decide({ platform, version: '0.19.1', seen: '0.19.0' }, content)).toEqual({
      kind: 'show',
      items: [ITEM_3, ITEM_1],
    })
  })

  it("shows to a user who never saw What's New", () => {
    expect(decide({ seen: null }).kind).toBe('show')
  })

  it('waits outside the main window, on Android, and until a graph opens', () => {
    expect(decide({ isMainWindow: false }).kind).toBe('wait')
    expect(decide({ platform: null }).kind).toBe('wait')
    expect(decide({ graphOpened: false }).kind).toBe('wait')
    expect(decide({ graphOpened: false, override: true }).kind).toBe('wait')
  })

  it('waits for the blocker, even with the override on', () => {
    const blockers: WhatsNewBlocker[] = ['pending', 'blocked']
    for (const blocker of blockers) {
      expect(decide({ blocker }).kind).toBe('wait')
      expect(decide({ blocker, override: true }).kind).toBe('wait')
    }
  })

  it('waits in a development build and after the version was seen', () => {
    expect(decide({ isDev: true }).kind).toBe('wait')
    expect(decide({ seen: '0.19.1' }).kind).toBe('wait')
  })

  it('skips a version after the setup and a version without items for the platform', () => {
    expect(decide({ setupSeen: true }).kind).toBe('skip')
    expect(decide({ version: '0.19.0', seen: '0.18.0', platform: 'ios' }).kind).toBe('skip')
    expect(decide({ version: '0.20.0' }).kind).toBe('skip')
  })

  it('skips after the setup even when a deep link arrived', () => {
    expect(decide({ setupSeen: true, deepLinkSeen: true }).kind).toBe('skip')
  })

  it('waits after a deep link', () => {
    expect(decide({ deepLinkSeen: true }).kind).toBe('wait')
  })

  it('shows with the override despite a development build, a seen version, or the setup', () => {
    expect(decide({ override: true, isDev: true, seen: '0.19.1', setupSeen: true })).toEqual({
      kind: 'show',
      items: [ITEM_2, ITEM_3],
    })
  })

  it('shows the newest items with the override when the version has none', () => {
    expect(decide({ override: true, version: '0.20.0' })).toEqual({
      kind: 'show',
      items: [ITEM_2, ITEM_3],
    })
    expect(decide({ override: true }, {}).kind).toBe('wait')
  })
})

interface SetupOptions {
  version?: string
  seen?: string | null
  blocker?: WhatsNewBlocker
  label?: string
  isDev?: boolean
  status?: GraphStatus
}

function setup(options: SetupOptions = {}) {
  const storage = createTestStorageService()
  if (options.seen) {
    storage.local.set(WHATS_NEW_SEEN_STORAGE_KEY, options.seen)
  }
  const graphSession = new WritableStore<{ readonly status: GraphStatus }>({
    status: options.status ?? 'ready',
  })
  const intake = createTestDeepLinkIntakeService()
  const activity = createTestActivityPort()
  const blocker = new WritableStore<WhatsNewBlocker>(options.blocker ?? 'clear')
  const whatsNew = createWhatsNewService({
    storage,
    platform: createTestPlatformService({
      appPlatform: 'desktop',
      appVersion: options.version ?? '0.19.1',
      isDev: options.isDev ?? false,
    }),
    window: createTestWindowService(
      options.label === undefined ? undefined : { label: options.label },
    ),
    graphSession,
    intake,
    activity,
    blocker,
    content: CONTENT,
  })
  const stop = whatsNew.start()
  const setStatus = (status: GraphStatus) => graphSession.set({ status })
  const seen = () => storage.local.get(WHATS_NEW_SEEN_STORAGE_KEY)
  return { whatsNew, storage, intake, activity, blocker, setStatus, seen, stop }
}

describe('createWhatsNewService', () => {
  it('shows after a normal launch and hides once dismissed', () => {
    const { whatsNew, setStatus, seen } = setup({ seen: '0.19.0', status: 'loading' })
    expect(whatsNew.gate.get().kind).toBe('hidden')
    setStatus('opening')
    setStatus('ready')
    expect(whatsNew.gate.get()).toEqual({ kind: 'whatsNew', items: [ITEM_2, ITEM_3] })

    whatsNew.dismiss()
    expect(whatsNew.gate.get().kind).toBe('hidden')
    expect(seen()).toBe('0.19.1')
  })

  it('marks the version seen without showing after the graph chooser', () => {
    const { whatsNew, setStatus, seen } = setup({ status: 'loading' })
    setStatus('choosing')
    setStatus('opening')
    setStatus('ready')
    expect(whatsNew.gate.get().kind).toBe('hidden')
    expect(seen()).toBe('0.19.1')
  })

  it('ignores a graph switch after the first open', () => {
    const { whatsNew, setStatus, seen } = setup({ seen: '0.19.0' })
    setStatus('choosing')
    expect(whatsNew.gate.get().kind).toBe('whatsNew')
    expect(seen()).toBe('0.19.0')
  })

  it('marks a version without items seen', () => {
    const { whatsNew, seen } = setup({ version: '0.20.0', seen: '0.19.1' })
    expect(whatsNew.gate.get().kind).toBe('hidden')
    expect(seen()).toBe('0.20.0')
  })

  it('waits for the blocker, and hides without marking the version seen when it blocks', () => {
    const { whatsNew, blocker, seen } = setup({ seen: '0.19.0', blocker: 'pending' })
    expect(whatsNew.gate.get().kind).toBe('hidden')

    blocker.set('clear')
    expect(whatsNew.gate.get().kind).toBe('whatsNew')

    blocker.set('blocked')
    expect(whatsNew.gate.get().kind).toBe('hidden')
    expect(seen()).toBe('0.19.0')
  })

  it('waits after a deep link until the app was hidden', () => {
    const { whatsNew, intake, activity } = setup({ seen: '0.19.0' })
    intake.dispatch('reflect://note/abc')
    expect(whatsNew.gate.get().kind).toBe('hidden')

    activity.emitHidden()
    expect(whatsNew.gate.get().kind).toBe('whatsNew')
  })

  it('stays hidden and marks nothing in a note window', () => {
    const { whatsNew, setStatus, seen } = setup({ label: 'note-1', status: 'loading' })
    setStatus('choosing')
    expect(whatsNew.gate.get().kind).toBe('hidden')
    expect(seen()).toBeNull()
  })

  it('shows in a development build only with the override, which dismiss turns off', () => {
    const { whatsNew, storage } = setup({ isDev: true, seen: '0.19.0' })
    expect(whatsNew.gate.get().kind).toBe('hidden')

    whatsNew.setOverride(true)
    expect(whatsNew.override.get()).toBe(true)
    expect(whatsNew.gate.get().kind).toBe('whatsNew')

    whatsNew.dismiss()
    expect(whatsNew.override.get()).toBe(false)
    expect(storage.session.get(WHATS_NEW_OVERRIDE_STORAGE_KEY)).toBeNull()
    expect(whatsNew.gate.get().kind).toBe('hidden')
  })

  it('keeps the gate reference when an input changes without changing the result', () => {
    const { whatsNew } = setup({ seen: '0.19.0' })
    const gate = whatsNew.gate.get()
    whatsNew.setOverride(true)
    expect(whatsNew.gate.get()).toBe(gate)
  })

  it('stops following its signals', () => {
    const { whatsNew, intake, stop } = setup({ seen: '0.19.0' })
    stop()
    intake.dispatch('reflect://note/abc')
    expect(whatsNew.gate.get().kind).toBe('whatsNew')
  })
})
