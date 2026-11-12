import { NO_ENTRY } from '@/mobile/native-chrome/protocol.ts'
import { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { useNativeMenuDrawer } from '@/mobile/native-chrome/native-menu.ts'
import { nativeMenuHandler } from '@/mobile/native-chrome/registrations.ts'
import { installNativeChrome } from '@/services/native-chrome-transport.ts'

function Picker({ onSelect }: { onSelect: (id: string) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const native = useNativeMenuDrawer({
    open,
    onOpenChange: setOpen,
    menuId: 'picker',
    items: [{ type: 'action', id: 'a', title: 'A' }],
    onSelect,
  })
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Choose
      </button>
      {open && !native ? <div role="dialog">web drawer</div> : null}
    </>
  )
}

afterEach(() => {
  installNativeChrome({}, document.documentElement)
})

describe('useNativeMenuDrawer', () => {
  it('asks the shell for a menu at the pressed control instead of opening the drawer', async () => {
    const postMessage = vi.fn()
    installNativeChrome(
      {
        __nativeChromeFeatures: ['menus'],
        webkit: {
          messageHandlers: { reflectHost: { postMessage }, reflectChrome: { postMessage } },
        },
      },
      document.documentElement,
    )
    const onSelect = vi.fn()
    const screen = await render(<Picker onSelect={onSelect} />)

    await userEvent.click(screen.getByRole('button', { name: 'Choose' }))

    expect(document.documentElement.dataset.nativeChrome).toBe('menus')
    expect(screen.container.querySelector('[role="dialog"]')).toBeNull()
    const message = postMessage.mock.calls.at(-1)?.[0] as { type: string; rect: { width: number } }
    expect(message.type).toBe('presentMenu')
    expect(message.rect.width).toBeGreaterThan(0)
    nativeMenuHandler('picker', NO_ENTRY)?.('a')
    expect(onSelect).toHaveBeenCalledWith('a')

    await screen.unmount()
    expect(nativeMenuHandler('picker', NO_ENTRY)).toBeNull()
  })

  it('opens the web drawer without the shell', async () => {
    const screen = await render(<Picker onSelect={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
    await expect.element(screen.getByRole('dialog')).toBeVisible()
  })
})
