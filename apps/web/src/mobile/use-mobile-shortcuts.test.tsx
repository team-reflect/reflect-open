import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import type { TestPlatformOptions } from '@reflect/core/testing'
import { useStore } from '@/lib/use-store.ts'
import { quickOpenVisible } from '@/mobile/quick-open.tsx'
import { useRouterState } from '@/routing/router.tsx'
import { act } from '@/test-utils/act.ts'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { useMobileShortcuts } from './use-mobile-shortcuts.ts'

function Probe(): ReactElement {
  useMobileShortcuts()
  const { route } = useRouterState()
  const quickOpen = useStore(quickOpenVisible)
  return (
    <>
      <output>{route.kind}</output>
      <p>{quickOpen ? 'quick open' : 'closed'}</p>
      <div data-testid="editor" onKeyDown={(event) => event.preventDefault()} />
    </>
  )
}

/**
 * The mobile platforms and the modifier of their `Mod` key.
 */
const PLATFORMS: {
  name: string
  platform: TestPlatformOptions
  mod: { metaKey?: boolean; ctrlKey?: boolean }
}[] = [
  { name: 'iOS', platform: MOBILE_PLATFORM, mod: { metaKey: true } },
  {
    name: 'Android',
    platform: { ...MOBILE_PLATFORM, appPlatform: 'android', isApplePlatform: false },
    mod: { ctrlKey: true },
  },
]

describe.each(PLATFORMS)('useMobileShortcuts on $name', ({ platform, mod }) => {
  async function press(
    target: EventTarget,
    key: string,
    mods: { shiftKey?: boolean } = {},
  ): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...mod,
      ...mods,
    })
    await act(() => {
      target.dispatchEvent(event)
    })
    return event
  }

  it('goes to today on Mod-d', async () => {
    const view = await renderInApp(<Probe />, { route: { kind: 'tasks' }, platform })
    await expect.element(view.getByRole('status')).toMatchTextContent('tasks')

    const event = await press(document.body, 'd')

    await expect.element(view.getByRole('status')).toMatchTextContent('today')
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens All notes on Mod-Shift-a and Tasks on Mod-t', async () => {
    const view = await renderInApp(<Probe />, { route: { kind: 'today' }, platform })

    await press(document.body, 'a', { shiftKey: true })
    await expect.element(view.getByRole('status')).toMatchTextContent('allNotes')

    await press(document.body, 't')
    await expect.element(view.getByRole('status')).toMatchTextContent('tasks')
  })

  it('opens Quick Open on Mod-k, unless the editor took the key', async () => {
    quickOpenVisible.set(false)
    const view = await renderInApp(<Probe />, { route: { kind: 'today' }, platform })

    await press(view.getByTestId('editor').element(), 'k')
    await expect.element(view.getByText('closed')).toBeInTheDocument()

    await press(document.body, 'k')
    await expect.element(view.getByText('quick open')).toBeInTheDocument()

    quickOpenVisible.set(false)
  })
})
