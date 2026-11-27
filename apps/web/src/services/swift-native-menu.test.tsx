import type { NativeChromeHost, NativeMenuHost } from '@reflect/app'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSwiftNativeMenuHost } from './swift-native-menu.ts'
import { noop } from '@ocavue/utils'

afterEach(() => {
  document.body.replaceChildren()
})

/**
 * A menu host over a fake shell, and a row at the top left of the page
 * whose `contextmenu` events go to `onContextMenu`.
 */
function setup(onContextMenu: (event: MouseEvent, host: NativeMenuHost) => void) {
  const posted: object[] = []
  let send: (payload: unknown) => void = noop
  const chrome: NativeChromeHost = {
    post: (message) => void posted.push(message),
    listenIntent: (listener) => {
      send = listener
      return noop
    },
  }
  const host = createSwiftNativeMenuHost(chrome, document)
  const row = document.createElement('div')
  row.style.cssText = 'position: fixed; inset: 0 auto auto 0; width: 100px; height: 40px'
  document.body.append(row)
  row.addEventListener('contextmenu', (event) => onContextMenu(event, host))
  return { posted, send: (payload: unknown) => send(payload) }
}

describe('createSwiftNativeMenuHost', () => {
  it('answers a request with the menu that a contextmenu handler opens, and runs the pick', () => {
    const action = vi.fn()
    const { posted, send } = setup((event, host) => {
      event.preventDefault()
      void host.popup([
        { kind: 'command', text: 'Pin', action },
        { kind: 'predefined', item: 'Separator' },
        { kind: 'submenu', text: 'More', items: [{ kind: 'command', text: 'Lock', action }] },
        { kind: 'command', text: 'Delete', destructive: true, action },
      ])
    })

    send({ type: 'contextMenu', request: 7, x: 10, y: 10 })
    send({ type: 'contextMenuSelect', request: 7, id: '2' })

    expect(posted).toEqual([
      {
        type: 'contextMenu',
        request: 7,
        items: [
          { type: 'section', items: [{ type: 'action', id: '0', title: 'Pin', disabled: false }] },
          {
            type: 'section',
            items: [
              {
                type: 'section',
                title: 'More',
                items: [{ type: 'action', id: '1', title: 'Lock', disabled: false }],
              },
              { type: 'action', id: '2', title: 'Delete', disabled: false, destructive: true },
            ],
          },
        ],
      },
    ])
    expect(action.mock.calls).toEqual([['2']])
  })

  it('answers with no items when no handler prevents the default', () => {
    const { posted, send } = setup(noop)

    send({ type: 'contextMenu', request: 1, x: 10, y: 10 })
    send({ type: 'contextMenu', request: 2, x: 300, y: 300 })

    expect(posted).toEqual([
      { type: 'contextMenu', request: 1, items: [] },
      { type: 'contextMenu', request: 2, items: [] },
    ])
  })

  it('waits for a menu opened after an await, and ignores a popup with no request', async () => {
    const opened = Promise.withResolvers<NativeMenuHost>()
    const { posted, send } = setup((event, host) => {
      event.preventDefault()
      opened.resolve(host)
    })
    const action = vi.fn()
    send({ type: 'contextMenu', request: 3, x: 10, y: 10 })
    expect(posted).toEqual([])
    const host = await opened.promise
    void host.popup([{ kind: 'command', text: 'Pin', action }])
    void host.popup([{ kind: 'command', text: 'Pin', action }])

    expect(posted).toEqual([
      {
        type: 'contextMenu',
        request: 3,
        items: [{ type: 'action', id: '0', title: 'Pin', disabled: false }],
      },
    ])
  })
})
