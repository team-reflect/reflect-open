import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `hapticImpactLight` is fire-and-forget over the keyboard plugin's
 * `impact_light` command, and must fail soft where the plugin isn't
 * registered (desktop, browser dev): one warning, then no further IPC.
 */

const invokeMock = vi.fn<(command: string) => Promise<unknown>>()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string) => invokeMock(command),
}))

async function loadHaptics(): Promise<() => void> {
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

    hapticImpactLight()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())

    hapticImpactLight()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
