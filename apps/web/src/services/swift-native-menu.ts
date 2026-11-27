import {
  createUnsupportedNativeMenuHost,
  type NativeChromeHost,
  type NativeMenuHost,
  type NativeMenuItem,
} from '@reflect/app'
import type { ChromeIntent, ChromeMessage, MenuItem } from '@reflect/types'
import { z } from 'zod'

/**
 * The schemas of the shell's context menu intents, which this host runs.
 */
export const CONTEXT_MENU_INTENT_SCHEMAS = [
  z.object({ type: z.literal('contextMenu'), request: z.number(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('contextMenuSelect'), request: z.number(), id: z.string() }),
] as const

// The shell is trusted; the schema keeps a malformed event from running.
const intentSchema = z.discriminatedUnion(
  'type',
  CONTEXT_MENU_INTENT_SCHEMAS,
) satisfies z.ZodType<ChromeIntent>

/**
 * The wire items of `items`, each command keyed in `actions` by the id it
 * gets. Separators split the items into sections, and a submenu becomes a
 * titled section: the wire menu has no submenus.
 */
function toWireItems(
  items: readonly NativeMenuItem[],
  actions: Map<string, () => void>,
): MenuItem[] {
  let section: MenuItem[] = []
  const sections = [section]
  for (const item of items) {
    if (item.kind === 'predefined') {
      if (item.item === 'Separator') {
        section = []
        sections.push(section)
      }
    } else if (item.kind === 'submenu') {
      section.push({ type: 'section', title: item.text, items: toWireItems(item.items, actions) })
    } else {
      const id = String(actions.size)
      actions.set(id, () => item.action(id))
      section.push({
        type: 'action',
        id,
        title: item.text,
        disabled: item.enabled === false,
        checked: item.checked,
        destructive: item.destructive,
      })
    }
  }
  const filled = sections.filter((items) => items.length > 0)
  return filled.length === 1
    ? filled.flat()
    : filled.map((items): MenuItem => ({ type: 'section', items }))
}

/**
 * Context menus in the Swift shell. A pointer's secondary click makes the
 * shell ask for the menu at a point; the host dispatches a `contextmenu`
 * event on the element there, so the page's ordinary handlers run, and the
 * next `popup` answers the shell. A handler that prevents the default may
 * open its menu after an `await`. A `popup` with no request waiting does
 * nothing, so WebKit's own `contextmenu` event opens no second menu.
 */
export function createSwiftNativeMenuHost(
  chrome: NativeChromeHost,
  document: Document,
): NativeMenuHost {
  let pending: number | null = null
  let shown: { request: number; actions: Map<string, () => void> } | null = null

  function answer(request: number, items: MenuItem[]): void {
    pending = null
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
        shown.actions.get(intent.id)?.()
      }
      return
    }
    pending = intent.request
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: intent.x,
      clientY: intent.y,
    })
    const prevented = document.elementFromPoint(intent.x, intent.y)?.dispatchEvent(event) === false
    if (!prevented && pending === intent.request) {
      answer(intent.request, [])
    }
  })

  return {
    ...createUnsupportedNativeMenuHost(),
    popup(items) {
      if (pending === null) {
        return
      }
      const actions = new Map<string, () => void>()
      shown = { request: pending, actions }
      answer(pending, toWireItems(items, actions))
    },
  }
}
