import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCaptureProbe } from './x-capture-probe'
import { captureFixture } from './x-capture-fixture'
import { captureProbeResponseSchema } from './x-capture-messages'

const { getTab, sendMessage } = vi.hoisted(() => ({ getTab: vi.fn(), sendMessage: vi.fn() }))
vi.mock('wxt/browser', () => ({ browser: { tabs: { get: getTab, sendMessage } } }))
const pageUrl = 'https://x.com/example/status/20'
function lookupResponse(): object {
  return {
    ok: true,
    pageUrl,
    documentToken: '6b9dbd9f-31ef-45aa-9148-c3c38cbcf59b',
    post: captureFixture(),
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  getTab.mockResolvedValue({ incognito: false, url: pageUrl })
  sendMessage.mockResolvedValue(lookupResponse())
})
afterEach(() => vi.unstubAllGlobals())

describe('capture probe', () => {
  it('keeps text and quote when a selected MP4 fails, counts HLS separately, and skips HLS fetches', async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: url.endsWith('.mp4') ? 403 : 200,
          headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const report = await runCaptureProbe(1, '20')
    expect(report.post).toEqual(captureFixture())
    expect(report.counts).toEqual({ videoCount: 2, mp4Available: 1, hlsOnly: 1, noSource: 0 })
    expect(report.results.filter((result) => result.status === 'read')).toHaveLength(4)
    expect(report.results).toContainEqual({
      slot: 'post.media.1',
      unavailable: false,
      status: 'failed',
      kind: 'video',
      reason: 'media-http-403',
    })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('.m3u8'))).toBe(false)
    expect(captureProbeResponseSchema.safeParse({ ok: true, report }).success).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      { type: 'x-capture:lookup', postId: '20' },
      { frameId: 0 },
    )
  })

  it.each([
    [{ incognito: true, url: pageUrl }, 'unsupported-tab'],
    [{ incognito: false, url: 'https://x.com/home' }, 'unsupported-tab'],
    [{ incognito: false, url: 'https://x.com/example/status/21' }, 'wrong-permalink'],
  ])('refuses a mismatched tab before querying the page', async (tab, reason) => {
    getTab.mockResolvedValue(tab)
    await expect(runCaptureProbe(1, '20')).rejects.toThrow(reason)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('reports an old tab without a listener and releases the in-flight guard', async () => {
    sendMessage.mockRejectedValueOnce(new Error('no receiving end'))
    await expect(runCaptureProbe(1, '20')).rejects.toThrow('lookup-unavailable')
    sendMessage.mockResolvedValueOnce({ ok: false, reason: 'not-observed' })
    await expect(runCaptureProbe(1, '20')).rejects.toThrow('not-observed')
  })

  it('rejects a changed tab before any privileged fetch', async () => {
    getTab
      .mockResolvedValueOnce({ incognito: false, url: pageUrl })
      .mockResolvedValueOnce({ incognito: false, url: 'https://x.com/example/status/21' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(runCaptureProbe(1, '20')).rejects.toThrow('page-changed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { ...lookupResponse(), post: { id: '20' } },
    { ...lookupResponse(), post: { ...captureFixture(), id: '21' } },
  ])('rejects malformed or wrong-ID page responses before fetching', async (response) => {
    sendMessage.mockResolvedValue(response)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(runCaptureProbe(1, '20')).rejects.toThrow(/invalid-snapshot|wrong-post/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prevents overlapping probes on the same tab', async () => {
    let release: (value: unknown) => void = () => {}
    sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const first = runCaptureProbe(1, '20')
    await expect(runCaptureProbe(1, '20')).rejects.toThrow('probe-already-running')
    release({ ok: false, reason: 'not-observed' })
    await expect(first).rejects.toThrow('not-observed')
  })
})
