import type { ReactElement } from 'react'
import { noop } from '@ocavue/utils'
import { createTestNativeChromeHost, createTestNativeChromeService } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { NativeChromeProjection } from '@/mobile/native-chrome/native-chrome-projection.tsx'
import { useNativeBar } from '@/mobile/native-chrome/registrations.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

function Screen(): ReactElement {
  useNativeBar({ trailing: [{ id: 'more', title: 'More' }] }, { onAction: noop })
  return <p>screen</p>
}

describe('NativeChromeProjection', () => {
  it('posts the bar of a new screen in its first state', async () => {
    const host = createTestNativeChromeHost()

    await renderInApp(
      <>
        <NativeChromeProjection tab="daily" keyboardVisible={false} onSelectTab={noop} />
        <Screen />
      </>,
      { appServices: { nativeChrome: createTestNativeChromeService(host) } },
    )

    await vi.waitFor(() => {
      expect(host.posted).toContainEqual(expect.objectContaining({ type: 'state' }))
    })
    const first = host.posted
      .map((message) => message as { type: string; trailing?: { id: string }[] })
      .find((message) => message.type === 'state')
    expect(first?.trailing?.map((button) => button.id)).toEqual(['more'])
  })
})
