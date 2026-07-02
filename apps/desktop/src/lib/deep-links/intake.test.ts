import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import {
  resetDeepLinkIntakeForTests,
  setDeepLinkHandler,
  startDeepLinkListener,
} from '@/lib/deep-links/intake'

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}))

const getCurrentMock = vi.mocked(getCurrent)
const onOpenUrlMock = vi.mocked(onOpenUrl)

/** The plugin callback captured by the last `onOpenUrl` subscription. */
function pluginDeliver(urls: string[]): void {
  const callback = onOpenUrlMock.mock.calls.at(-1)?.[0]
  if (callback === undefined) {
    throw new Error('onOpenUrl was never subscribed')
  }
  callback(urls)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDeepLinkIntakeForTests()
  getCurrentMock.mockResolvedValue(null)
  onOpenUrlMock.mockResolvedValue(() => {})
})

describe('deep-link intake', () => {
  it('subscribes to the plugin exactly once for the app lifetime', async () => {
    await startDeepLinkListener()
    await startDeepLinkListener()
    expect(onOpenUrlMock).toHaveBeenCalledTimes(1)
    expect(getCurrentMock).toHaveBeenCalledTimes(1)
  })

  it('buffers the launch URL from getCurrent — onOpenUrl does not replay it', async () => {
    getCurrentMock.mockResolvedValue(['reflect://note/launch-target'])
    await startDeepLinkListener()

    const handler = vi.fn()
    setDeepLinkHandler(handler)

    expect(handler).toHaveBeenCalledWith('reflect://note/launch-target')
  })

  it('retries after a failed subscription instead of latching disabled', async () => {
    onOpenUrlMock.mockRejectedValueOnce(new Error('plugin not ready'))

    await expect(startDeepLinkListener()).rejects.toThrow('plugin not ready')
    await startDeepLinkListener()

    expect(onOpenUrlMock).toHaveBeenCalledTimes(2)
  })

  it('tears down the subscription when getCurrent fails, so a retry cannot double-deliver', async () => {
    const unlisten = vi.fn()
    onOpenUrlMock.mockResolvedValue(unlisten)
    getCurrentMock.mockRejectedValueOnce(new Error('ipc failure'))

    await expect(startDeepLinkListener()).rejects.toThrow('ipc failure')
    expect(unlisten).toHaveBeenCalledTimes(1)

    await startDeepLinkListener()
    const handler = vi.fn()
    setDeepLinkHandler(handler)
    pluginDeliver(['reflect://today'])

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('delivers straight to an attached handler', async () => {
    await startDeepLinkListener()
    const handler = vi.fn()
    setDeepLinkHandler(handler)

    pluginDeliver(['reflect://today'])

    expect(handler).toHaveBeenCalledWith('reflect://today')
  })

  it('buffers URLs that arrive with no handler and replays them in order on attach', async () => {
    await startDeepLinkListener()
    pluginDeliver(['reflect://today', 'reflect://tasks'])

    const handler = vi.fn()
    setDeepLinkHandler(handler)

    expect(handler.mock.calls).toEqual([['reflect://today'], ['reflect://tasks']])
  })

  it('buffers again after the handler detaches (graph switch gap)', async () => {
    await startDeepLinkListener()
    const first = vi.fn()
    setDeepLinkHandler(first)
    setDeepLinkHandler(null)

    pluginDeliver(['reflect://daily/2026-07-01'])
    expect(first).not.toHaveBeenCalled()

    const second = vi.fn()
    setDeepLinkHandler(second)
    expect(second).toHaveBeenCalledWith('reflect://daily/2026-07-01')
  })
})
