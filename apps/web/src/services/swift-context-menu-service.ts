import type {
  ContextMenuItem,
  ContextMenuOptions,
  ContextMenuService,
  NativeChromeHost,
} from '@reflect/app'
import type { ChromeIntent, ChromeMessage, MenuItem } from '@reflect/types'
import { z } from 'zod'
import { CONTEXT_MENU_INTENT_SCHEMAS } from '@/mobile/chrome/native/protocol.ts'

const intentSchema = z.discriminatedUnion(
  'type',
  CONTEXT_MENU_INTENT_SCHEMAS,
) satisfies z.ZodType<ChromeIntent>

/**
 * Separators split the items into sections, and a submenu becomes a titled
 * section: the wire menu has no submenus.
 */
function toWireItems(items: readonly ContextMenuItem[]): MenuItem[] {
  let section: MenuItem[] = []
  const sections = [section]
  for (const item of items) {
    if (item.type === 'separator') {
      section = []
      sections.push(section)
    } else if (item.type === 'submenu') {
      section.push({ type: 'section', title: item.title, items: toWireItems(item.items) })
    } else {
      const { id, title, disabled, checked, destructive } = item
      section.push({ type: 'action', id, title, disabled, checked, destructive })
    }
  }
  const filled = sections.filter((items) => items.length > 0)
  return filled.length === 1
    ? filled.flat()
    : filled.map((items): MenuItem => ({ type: 'section', items }))
}

/**
 * Context menus in the Swift shell. A pointer's secondary click makes the
 * shell ask for the menu at a point. The service dispatches a `contextmenu`
 * event on the element there, and an `open` inside that event answers the
 * shell. An event that no `open` claims answers with no items.
 */
export function createSwiftContextMenuService(
  chrome: NativeChromeHost,
  document: Document,
): ContextMenuService {
  // The request whose event is being dispatched, until an `open` claims it.
  let current: number | null = null
  // The shell waits only for its latest request.
  let latest: number | null = null
  let shown: { request: number; onSelect: (id: string) => void } | null = null

  function answer(request: number, items: MenuItem[]): void {
    chrome.post({ type: 'contextMenu', request, items } satisfies ChromeMessage)
  }

  chrome.listenIntent((payload) => {
    const parsed = intentSchema.safeParse(payload)
    if (!parsed.success) {
      return
    }
    const intent = parsed.data
    if (intent.type === 'contextMenuSelect') {
      if (shown?.request === intent.request) {
        shown.onSelect(intent.id)
      }
      return
    }
    current = intent.request
    latest = intent.request
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: intent.x,
      clientY: intent.y,
    })
    document.elementFromPoint(intent.x, intent.y)?.dispatchEvent(event)
    if (current !== null) {
      current = null
      answer(intent.request, [])
    }
  })

  return {
    async open({ items, onSelect }: ContextMenuOptions) {
      const request = current
      if (request === null) {
        return
      }
      current = null
      let resolved: readonly ContextMenuItem[] = []
      try {
        resolved = await items
      } catch {
        // A menu whose items fail shows nothing.
      }
      if (request !== latest) {
        return
      }
      shown = { request, onSelect }
      answer(request, toWireItems(resolved))
    },
  }
}
