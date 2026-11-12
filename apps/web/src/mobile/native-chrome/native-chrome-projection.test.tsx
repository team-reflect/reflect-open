import type { ReactElement } from 'react'
import { noop } from '@ocavue/utils'
import { createTestLoggerService } from '@reflect/core/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChromeProjection } from '@/mobile/native-chrome/native-chrome-projection.tsx'
import { useNativeBar } from '@/mobile/native-chrome/registrations.ts'
import { installNativeChrome } from '@/services/native-chrome-transport.ts'
import { installHostEvents } from '@/services/swift-events.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

function Screen(): ReactElement {
  useNativeBar({ title: 'Roadmap', trailing: [{ id: 'more', title: 'More' }] }, { onAction: noop })
  return <p>screen</p>
}

afterEach(() => {
  installNativeChrome({}, document.documentElement)
})

describe('NativeChromeProjection', () => {
  it('posts the bar of a new screen in its first state', async () => {
    installHostEvents(window, createTestLoggerService())
    const postMessage = vi.fn()
    installNativeChrome(
      {
        __nativeChromeFeatures: ['tabbar', 'navbar'],
        webkit: {
          messageHandlers: { reflectHost: { postMessage }, reflectChrome: { postMessage } },
        },
      },
      document.documentElement,
    )

    await renderInApp(
      <>
        <NativeChromeProjection tab="daily" keyboardVisible={false} onSelectTab={noop} />
        <Screen />
      </>,
    )

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }))
    })
    const first = postMessage.mock.calls
      .map(([message]) => message as { type: string; title?: string | null })
      .find((message) => message.type === 'state')
    expect(first?.title).toBe('Roadmap')
  })
})
