import { createUnsupportedNativeMenuHost, type NativeMenuHost } from '@reflect/app'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Context menus drawn in the page. The menu code loads on the first popup.
 */
export function createBrowserNativeMenuHost(): NativeMenuHost {
  let pointer = { x: 0, y: 0 }
  let root: Root | null = null
  let opened = 0
  // Capture phase: the right-clicked row stops the event from bubbling.
  document.addEventListener(
    'contextmenu',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY }
    },
    { capture: true },
  )

  return {
    ...createUnsupportedNativeMenuHost(),
    async popup(items) {
      const at = pointer
      const { BrowserContextMenu } = await import('@/components/browser-context-menu.tsx')
      root ??= createRoot(document.body.appendChild(document.createElement('div')))
      opened += 1
      const menu = opened
      // A new key replaces the open menu, even one that is still closing.
      root.render(
        <BrowserContextMenu
          key={menu}
          items={items}
          point={at}
          onClosed={() => {
            if (menu === opened) {
              root?.render(null)
            }
          }}
        />,
      )
    },
  }
}
