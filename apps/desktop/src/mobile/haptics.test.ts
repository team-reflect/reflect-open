import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `hapticImpactLight` is fire-and-forget over the keyboard plugin's
 * `impact_light` command, and must fail soft where the plugin isn't
 * registered (desktop, browser dev): one warning, then no further IPC.
 */

const invokeMock = vi.fn<(command: string) => Promise<unknown>>()

async function loadHaptics(): Promise<() => void> {
  // resetModules gives this test a fresh latch and a fresh @reflect/core —
  // install the fake bridge on the same instance the module under test sees.
  const core = await import('@reflect/core')
  core.setBridge({
    invoke: (command) => invokeMock(command),
    listen: async () => () => {},
  })
  const module = await import('./haptics')
  return module.hapticImpactLight
}

beforeEach(() => {
  vi.resetModules()
  invokeMock.mockReset()
})

describe('hapticImpactLight', () => {
  it('fires the plugin impact command on every call while the bridge works', async () => {
    invokeMock.mockResolvedValue(null)
    const hapticImpactLight = await loadHaptics()

    hapticImpactLight()
    hapticImpactLight()

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock).toHaveBeenCalledWith('plugin:keyboard|impact_light')
  })

  it('warns once and stops invoking after the bridge rejects', async () => {
    invokeMock.mockRejectedValue(new Error('plugin keyboard not found'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hapticImpactLight = await loadHaptics()

    // Two taps with both invokes in flight: only the first rejection warns.
    hapticImpactLight()
    hapticImpactLight()
    expect(invokeMock).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())

    hapticImpactLight()
    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
