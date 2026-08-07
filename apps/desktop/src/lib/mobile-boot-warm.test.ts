import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The warm slot holds module state (the in-flight promise), so each test
 * imports a fresh copy of the module — and installs the fake bridge on the
 * same fresh registry, since `vi.resetModules()` resets `@reflect/core`'s
 * bridge slot too.
 */
async function freshModule(
  invoke: (command: string) => Promise<unknown>,
): Promise<typeof import('./mobile-boot-warm')> {
  vi.resetModules()
  const core = await import('@reflect/core')
  core.setBridge({ invoke: async (command) => await invoke(command), listen: async () => () => {} })
  return await import('./mobile-boot-warm')
}

const STORAGE = {
  localRoot: '/Documents',
  icloudDocumentsRoot: '/iCloud/Documents',
  icloudGraphRoots: [],
}

afterEach(() => {
  vi.resetModules()
})

describe('mobile-boot-warm', () => {
  it('starts the resolve once and hands it to exactly one taker', async () => {
    let storageCalls = 0
    const { warmMobileStorage, takeWarmMobileStorage } = await freshModule(async (command) => {
      if (command === 'mobile_storage') {
        storageCalls += 1
        return STORAGE
      }
      return null
    })
    warmMobileStorage()
    warmMobileStorage() // idempotent — still one IPC
    expect(storageCalls).toBe(1)

    const taken = takeWarmMobileStorage()
    expect(taken).not.toBeNull()
    await expect(taken).resolves.toEqual(STORAGE)
    // Consume-once: the slot is a boot hint, not a cache — a second taker
    // must fall back to its own fresh call.
    expect(takeWarmMobileStorage()).toBeNull()
    expect(storageCalls).toBe(1)
  })

  it('returns null when nothing was warmed', async () => {
    let storageCalls = 0
    const { takeWarmMobileStorage } = await freshModule(async () => {
      storageCalls += 1
      return STORAGE
    })
    expect(takeWarmMobileStorage()).toBeNull()
    expect(storageCalls).toBe(0)
  })

  it('does not surface an unhandled rejection when the warm fails untaken', async () => {
    const { warmMobileStorage } = await freshModule(async () => {
      throw new Error('no container')
    })
    warmMobileStorage()
    // Settle the rejection with no taker attached; the module's internal
    // catch keeps it from escaping as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
