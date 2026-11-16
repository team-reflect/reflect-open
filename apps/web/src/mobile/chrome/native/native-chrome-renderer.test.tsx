import { createRef, type ReactElement } from 'react'
import { createTestNativeChromeHost } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { useScreenChrome } from '@/mobile/chrome/chrome-renderer.ts'
import { ChromeTopBar } from '@/mobile/chrome/chrome-top-bar.tsx'
import type { Focusable } from '@/mobile/chrome/screen-chrome.ts'
import { lastChromeState, nativeChromeOptions } from '@/test-utils/native-chrome.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

function Screen({ id = 'more' }: { id?: string | undefined }): ReactElement {
  useScreenChrome({ trailing: [{ id, title: id }] })
  return <p>screen</p>
}

function postedTrailing(host: ReturnType<typeof createTestNativeChromeHost>): string[][] {
  return host.posted
    .map((message) => message as { type: string; trailing?: { id: string }[] })
    .filter((message) => message.type === 'state')
    .map((message) => (message.trailing ?? []).map((button) => button.id))
}

describe('NativeChromeRenderer', () => {
  it('posts the bar of a new screen in its first state', async () => {
    const host = createTestNativeChromeHost()

    await renderInApp(<Screen />, nativeChromeOptions(host))

    await vi.waitFor(() => {
      expect(host.posted).toContainEqual(expect.objectContaining({ type: 'state' }))
    })
    const first = host.posted
      .map((message) => message as { type: string; trailing?: { id: string }[] })
      .find((message) => message.type === 'state')
    expect(first?.trailing?.map((button) => button.id)).toEqual(['more'])
  })

  it('posts one state when a screen changes its buttons', async () => {
    const host = createTestNativeChromeHost()
    const view = await renderInApp(<Screen />, nativeChromeOptions(host))
    await vi.waitFor(() => {
      expect(postedTrailing(host).at(-1)).toEqual(['more'])
    })
    const before = postedTrailing(host).length

    await view.rerender(<Screen id="share" />)

    await vi.waitFor(() => {
      expect(postedTrailing(host).at(-1)).toEqual(['share'])
    })
    expect(postedTrailing(host).slice(before)).toEqual([['share']])
  })

  it('leaves the main row to the shell', async () => {
    const host = createTestNativeChromeHost()
    const view = await renderInApp(
      <ChromeTopBar back={vi.fn()} title="Tag" />,
      nativeChromeOptions(host),
    )
    await vi.waitFor(() => {
      expect(lastChromeState(host)?.title).toEqual({ kind: 'text', text: 'Tag' })
    })
    expect(view.container.querySelector('header')).toBeNull()
  })

  it("grows the search revision only for the screen's own changes", async () => {
    const host = createTestNativeChromeHost()
    const onChange = vi.fn()
    const screen = (value: string): ReactElement => (
      <ChromeTopBar
        search={{ value, placeholder: 'Search tasks…', label: 'Search tasks', onChange }}
      />
    )
    const view = await renderInApp(screen(''), nativeChromeOptions(host))
    await vi.waitFor(() => {
      expect(lastChromeState(host)?.search).toMatchObject({ text: '', revision: 0 })
    })
    const entryId = lastChromeState(host)?.entryId

    // The shell's typing comes back as the screen's value: an echo.
    host.sendIntent({ type: 'search', entryId, text: 'ab' })
    expect(onChange).toHaveBeenCalledWith('ab')
    await view.rerender(screen('ab'))
    await vi.waitFor(() => {
      expect(lastChromeState(host)?.search).toMatchObject({ text: 'ab', revision: 0 })
    })

    // The screen clears the field itself.
    await view.rerender(screen(''))
    await vi.waitFor(() => {
      expect(lastChromeState(host)?.search).toMatchObject({ text: '', revision: 1 })
    })

    // The echo counts once: the screen setting the shell's old text again is
    // its own change.
    await view.rerender(screen('ab'))
    await vi.waitFor(() => {
      expect(lastChromeState(host)?.search).toMatchObject({ text: 'ab', revision: 2 })
    })
  })

  it("focuses the shell's search field through the search ref", async () => {
    const host = createTestNativeChromeHost()
    const ref = createRef<Focusable>()
    await renderInApp(
      <ChromeTopBar
        search={{ value: '', placeholder: 'Search', label: 'Search', onChange: vi.fn(), ref }}
      />,
      nativeChromeOptions(host),
    )
    await vi.waitFor(() => {
      expect(lastChromeState(host)?.search).not.toBeNull()
    })
    ref.current?.focus()
    expect(host.posted).toContainEqual({
      type: 'focusSearch',
      entryId: lastChromeState(host)?.entryId,
    })
  })

  it('publishes the width of the window controls', async () => {
    const host = createTestNativeChromeHost()
    await renderInApp(<ChromeTopBar title="Tag" />, nativeChromeOptions(host))
    await vi.waitFor(() => {
      expect(host.posted).toContainEqual({ type: 'chromeReady' })
    })
    host.sendIntent({ type: 'windowControls', width: 88 })
    await vi.waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--window-controls-width')).toBe(
        '88px',
      )
    })
    host.sendIntent({ type: 'windowControls', width: 0 })
  })
})
