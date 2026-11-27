import { createUnsupportedNativeMenuHost, type NativeMenuHost } from '@reflect/app'

/**
 * Context menus drawn in the page, for a plain browser. The menu code loads on the first popup.
 */
export function createBrowserNativeMenuHost(): NativeMenuHost {
  let pointer = { x: 0, y: 0 }
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
      const { showBrowserContextMenu } = await import('@/components/browser-context-menu.tsx')
      showBrowserContextMenu(items, at)
    },
  }
}
