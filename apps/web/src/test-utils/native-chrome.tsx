import type { ReactElement } from 'react'
import { noop } from '@ocavue/utils'
import { createTestNativeChromeService, type TestNativeChromeHost } from '@reflect/app/testing'
import { useChromeRenderer } from '@/mobile/chrome/chrome-renderer.ts'
import type { NativeChromeState } from '@/mobile/chrome/native/protocol.ts'
import type { RenderInAppOptions } from '@/test-utils/render-in-app.tsx'

function TestShellBars(): ReactElement {
  const renderer = useChromeRenderer()
  return <renderer.ShellBars form="bar" tab="daily" keyboardVisible={false} onSelectTab={noop} />
}

/**
 * The `renderInApp` options of a shell that draws the native chrome over
 * `host`, with the shell bars mounted beside the rendered UI.
 */
export function nativeChromeOptions(
  host: TestNativeChromeHost,
): Pick<RenderInAppOptions, 'appServices' | 'wrapper'> {
  return {
    appServices: { nativeChrome: createTestNativeChromeService(host) },
    wrapper: (children) => (
      <>
        {children}
        <TestShellBars />
      </>
    ),
  }
}

function isChromeState(message: object): message is NativeChromeState {
  return 'type' in message && message.type === 'state'
}

/**
 * The last chrome state posted to `host`.
 */
export function lastChromeState(host: TestNativeChromeHost): NativeChromeState | undefined {
  return host.posted.findLast(isChromeState)
}
