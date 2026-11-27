import type {
  ContextMenuItem,
  ContextMenuOptions,
  ContextMenuService,
  NativeChromeHost,
} from '@reflect/app'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSwiftContextMenuService } from './swift-context-menu-service.ts'
import { noop } from '@ocavue/utils'

afterEach(() => {
  document.body.replaceChildren()
})

/**
 * The service over a fake shell, and a row at the top left of the page
 * whose `contextmenu` events go to `onContextMenu`.
 */
function setup(onContextMenu: (event: MouseEvent, service: ContextMenuService) => void) {
  const posted: object[] = []
  let send: (payload: unknown) => void = noop
  const chrome: NativeChromeHost = {
    post: (message) => void posted.push(message),
    listenIntent: (listener) => {
      send = listener
      return noop
    },
  }
  const service = createSwiftContextMenuService(chrome, document)
  const row = document.createElement('div')
  row.style.cssText = 'position: fixed; inset: 0 auto auto 0; width: 100px; height: 40px'
  document.body.append(row)
  row.addEventListener('contextmenu', (event) => onContextMenu(event, service))
  return { posted, service, send: (payload: unknown) => send(payload) }
}

describe('createSwiftContextMenuService', () => {
  it('answers with the menu that the handler opens, and a pick runs its `onSelect`', async () => {
    const onSelect = vi.fn()
    const { posted, send } = setup((event, service) => {
      event.preventDefault()
      void service.open({
        items: [
          { type: 'action', id: 'pin', title: 'Pin' },
          { type: 'separator' },
          {
            type: 'submenu',
            title: 'More',
            items: [{ type: 'action', id: 'lock', title: 'Lock' }],
          },
          { type: 'action', id: 'delete', title: 'Delete', destructive: true },
        ],
        onSelect,
      })
    })

    send({ type: 'contextMenu', request: 7, x: 10, y: 10 })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    send({ type: 'contextMenuSelect', request: 7, id: 'delete' })

    expect(posted).toEqual([
      {
        type: 'contextMenu',
        request: 7,
        items: [
          { type: 'section', items: [{ type: 'action', id: 'pin', title: 'Pin' }] },
          {
            type: 'section',
            items: [
              {
                type: 'section',
                title: 'More',
                items: [{ type: 'action', id: 'lock', title: 'Lock' }],
              },
              { type: 'action', id: 'delete', title: 'Delete', destructive: true },
            ],
          },
        ],
      },
    ])
    expect(onSelect.mock.calls).toEqual([['delete']])
  })

  it('never answers a later request with the items of a slow earlier one', async () => {
    const slow = Promise.withResolvers<ContextMenuItem[]>()
    const first = vi.fn()
    const onSelect = vi.fn()
    const menus: ContextMenuOptions[] = [
      { items: slow.promise, onSelect: first },
      { items: [{ type: 'action', id: 'pin', title: 'Unpin' }], onSelect },
    ]
    const { posted, send } = setup((event, service) => {
      event.preventDefault()
      void service.open(menus.shift()!)
    })

    send({ type: 'contextMenu', request: 1, x: 10, y: 10 })
    send({ type: 'contextMenu', request: 2, x: 10, y: 10 })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    slow.resolve([{ type: 'action', id: 'pin', title: 'Pin' }])
    await slow.promise
    send({ type: 'contextMenuSelect', request: 2, id: 'pin' })

    expect(posted).toEqual([
      { type: 'contextMenu', request: 2, items: [{ type: 'action', id: 'pin', title: 'Unpin' }] },
    ])
    expect(onSelect.mock.calls).toEqual([['pin']])
    expect(first).not.toHaveBeenCalled()
  })

  it('answers with no items when the handler prevents the default without opening', () => {
    const { posted, send } = setup((event) => event.preventDefault())

    send({ type: 'contextMenu', request: 1, x: 10, y: 10 })

    expect(posted).toEqual([{ type: 'contextMenu', request: 1, items: [] }])
  })

  it('answers with no items when the items reject', async () => {
    const { posted, send } = setup((event, service) => {
      event.preventDefault()
      void service.open({ items: Promise.reject(new Error('index')), onSelect: noop })
    })

    send({ type: 'contextMenu', request: 1, x: 10, y: 10 })

    await vi.waitFor(() => expect(posted).toEqual([{ type: 'contextMenu', request: 1, items: [] }]))
  })

  it('does nothing for an `open` outside a request', async () => {
    const { posted, service } = setup(noop)

    await service.open({ items: [{ type: 'action', id: 'pin', title: 'Pin' }], onSelect: noop })

    expect(posted).toEqual([])
  })
})
