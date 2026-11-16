import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
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

async function press(
  target: EventTarget,
  key: string,
  mods: { shiftKey?: boolean } = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    // iOS is an Apple platform, so `Mod` is ⌘ whatever the host OS of the test.
    metaKey: true,
    ...mods,
  })
  await act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('useMobileShortcuts', () => {
  it('goes to today on ⌘D', async () => {
    const view = await renderInApp(<Probe />, {
      route: { kind: 'tasks' },
      platform: MOBILE_PLATFORM,
    })
    await expect.element(view.getByRole('status')).toMatchTextContent('tasks')

    const event = await press(document.body, 'd')

    await expect.element(view.getByRole('status')).toMatchTextContent('today')
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens All notes on ⌘⇧A and Tasks on ⌘T', async () => {
    const view = await renderInApp(<Probe />, {
      route: { kind: 'today' },
      platform: MOBILE_PLATFORM,
    })

    await press(document.body, 'a', { shiftKey: true })
    await expect.element(view.getByRole('status')).toMatchTextContent('allNotes')

    await press(document.body, 't')
    await expect.element(view.getByRole('status')).toMatchTextContent('tasks')
  })

  it('opens Quick Open on ⌘K, unless the editor took the key', async () => {
    quickOpenVisible.set(false)
    const view = await renderInApp(<Probe />, {
      route: { kind: 'today' },
      platform: MOBILE_PLATFORM,
    })

    await press(view.getByTestId('editor').element(), 'k')
    await expect.element(view.getByText('closed')).toBeInTheDocument()

    await press(document.body, 'k')
    await expect.element(view.getByText('quick open')).toBeInTheDocument()

    quickOpenVisible.set(false)
  })
})
