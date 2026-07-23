import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkClickHandler } from '@meowdown/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { useOpenExternalLink } from '@/editor/open-external-link'

const openDeepLinkInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
}))

vi.mock('@/lib/deep-links/intake', () => ({
  dispatchDeepLink: vi.fn(),
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openDeepLinkInNewWindow,
}))

let openExternalLink: LinkClickHandler

function click(href: string, metaKey = false): MouseEvent {
  const event = new MouseEvent('click', { cancelable: true, metaKey })
  act(() => openExternalLink({ href, event }))
  return event
}

beforeEach(async () => {
  vi.clearAllMocks()
  openDeepLinkInNewWindow.mockResolvedValue(true)
  const { result } = await renderHook(() => useOpenExternalLink())
  openExternalLink = result.current
})

afterEach(cleanup)

describe('openExternalLink', () => {
  it('opens an http(s) link in the OS browser and blocks the frame navigation', async () => {
    const event = click('https://example.com')

    expect(openUrl).toHaveBeenCalledWith('https://example.com')
    expect(event.defaultPrevented).toBe(true)
  })

  it('routes a reflect:// link through the in-app deep-link intake, not the URL opener', async () => {
    click('reflect://note/abc123')

    expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/abc123')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('⌘-clicks a rendered reflect:// link into a secondary window', async () => {
    click('reflect://note/abc123', true)

    await vi.waitFor(() =>
      expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/abc123'),
    )
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('falls back to in-window dispatch when a rendered deep link cannot open a window', async () => {
    openDeepLinkInNewWindow.mockResolvedValue(false)
    click('reflect://note/abc123', true)

    await vi.waitFor(() => expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/abc123'))
  })

  it('opens a custom app scheme in its OS default app', async () => {
    const event = click('x-devonthink-item://40C88434-68B6-4DCB-A258-754679764C3C')

    expect(openUrl).toHaveBeenCalledWith('x-devonthink-item://40C88434-68B6-4DCB-A258-754679764C3C')
    expect(event.defaultPrevented).toBe(true)
  })

  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['blob:https://example.com/uuid'],
  ])('drops the unsafe scheme %s without opening anything', (href) => {
    const event = click(href)

    expect(openUrl).not.toHaveBeenCalled()
    expect(dispatchDeepLink).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('drops a scheme-less relative href', async () => {
    const event = click('notes/foo.md')

    expect(openUrl).not.toHaveBeenCalled()
    expect(dispatchDeepLink).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })
})
