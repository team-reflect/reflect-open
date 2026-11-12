import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  NO_ENTRY,
  type NativeChromeMessage,
  type NativeMenuItem,
} from '@/mobile/native-chrome/protocol.ts'
import { forgetNativeMenu, rememberNativeMenu } from '@/mobile/native-chrome/registrations.ts'
import { useOptionalRouterState } from '@/routing/router.tsx'
import { hasNativeChrome, postNativeChrome } from '@/services/native-chrome-transport.ts'

let lastPressed: Element | null = null
let lastPressedAt = 0
let tracking = false

/** How long a press can anchor a menu that opens after it. */
const PRESS_ANCHOR_MS = 1000

/**
 * Remember the element of the last press, so a drawer that opens from it can
 * anchor the native menu there.
 */
function trackPresses(): void {
  if (tracking) {
    return
  }
  tracking = true
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastPressed = event.target instanceof Element ? event.target : null
      lastPressedAt = event.timeStamp
    },
    { capture: true },
  )
}

/**
 * The control under the last press, while it is in the page and the press
 * is recent; `null` otherwise (a drawer opened from code or the keyboard).
 */
function lastPressedControl(): Element | null {
  if (
    lastPressed === null ||
    !lastPressed.isConnected ||
    performance.now() - lastPressedAt > PRESS_ANCHOR_MS
  ) {
    return null
  }
  return lastPressed.closest('button, [role="button"], a, label') ?? lastPressed
}

/**
 * Ask the shell to show `items` as a native menu at `anchor`. A tap on an
 * item calls `onSelect` with its id, while the page still shows `entryId`.
 */
export function presentNativeMenu({
  entryId,
  menuId,
  anchor,
  items,
  onSelect,
}: {
  entryId: number
  menuId: string
  anchor: Element | null
  items: NativeMenuItem[]
  onSelect: (id: string) => void
}): void {
  const rect = anchor?.getBoundingClientRect() ?? {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    width: 0,
    height: 0,
  }
  rememberNativeMenu(menuId, { entryId, onSelect })
  postNativeChrome({
    type: 'presentMenu',
    entryId,
    menuId,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    items,
  } satisfies NativeChromeMessage)
}

interface NativeMenuDrawerOptions {
  open: boolean
  onOpenChange: (open: boolean) => void
  menuId: string
  items: NativeMenuItem[]
  onSelect: (id: string) => void
}

/**
 * Show a drawer of plain choices as a native menu when the shell draws
 * menus: when the drawer opens, the shell shows `items` at the control the
 * user pressed and the drawer closes again. Returns whether the shell shows
 * the choices, so the caller keeps its drawer closed.
 */
export function useNativeMenuDrawer({
  open,
  onOpenChange,
  menuId,
  items,
  onSelect,
}: NativeMenuDrawerOptions): boolean {
  const native = hasNativeChrome('menus')
  const entryId = useOptionalRouterState()?.entryId ?? NO_ENTRY
  const latestRef = useRef({ items, onSelect, onOpenChange })
  useLayoutEffect(() => {
    latestRef.current = { items, onSelect, onOpenChange }
  })
  // One handler per mounted drawer, so an unmount forgets only its own menu.
  const [select] = useState(() => (id: string) => latestRef.current.onSelect(id))
  useEffect(() => () => forgetNativeMenu(menuId, select), [menuId, select])

  useEffect(() => {
    if (native) {
      trackPresses()
    }
  }, [native])

  useEffect(() => {
    if (!native || !open) {
      return
    }
    presentNativeMenu({
      entryId,
      menuId,
      anchor: lastPressedControl(),
      items: latestRef.current.items,
      onSelect: select,
    })
    latestRef.current.onOpenChange(false)
  }, [native, open, entryId, menuId, select])

  return native
}
