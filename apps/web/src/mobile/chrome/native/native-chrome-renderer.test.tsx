import type { ReactElement } from 'react'
import { createTestNativeChromeHost } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { useScreenChrome } from '@/mobile/chrome/chrome-renderer.ts'
import { nativeChromeOptions } from '@/test-utils/native-chrome.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

function Screen(): ReactElement {
  useScreenChrome({ trailing: [{ id: 'more', title: 'More' }] })
  return <p>screen</p>
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
})
