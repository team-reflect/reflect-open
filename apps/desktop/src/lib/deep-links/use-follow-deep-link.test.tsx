import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ReactElement } from 'react'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { RouterProvider, useRouter } from '@/routing/router'
import { type FollowDeepLink, useFollowDeepLink } from './use-follow-deep-link'

const dispatchDeepLink = vi.hoisted(() => vi.fn())
const openDeepLinkInNewWindow = vi.hoisted(() =>
  vi.fn<(href: string) => Promise<boolean>>(),
)
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('@/lib/deep-links/intake', () => ({ dispatchDeepLink }))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openDeepLinkInNewWindow,
  openRouteInNewWindow,
}))

let followDeepLink: FollowDeepLink | null = null

function Host(): ReactElement {
  followDeepLink = useFollowDeepLink()
  const openNoteLink = useNoteLinkNavigation()
  return (
    <button
      type="button"
      onClick={(event) =>
        openNoteLink({ kind: 'note', path: 'notes/newer-link.md' }, event)
      }
    >
      Open newer note link
    </button>
  )
}

function NavigateAway(): ReactElement {
  const { navigate } = useRouter()
  return (
    <button type="button" onClick={() => navigate({ kind: 'note', path: 'notes/newer.md' })}>
      Navigate away
    </button>
  )
}

function Harness({ showHost = true }: { readonly showHost?: boolean }): ReactElement {
  return (
    <RouterProvider>
      {showHost ? <Host /> : null}
      <NavigateAway />
    </RouterProvider>
  )
}

function modifierClick(href = 'reflect://note/older'): void {
  followDeepLink?.(href, new MouseEvent('click', { metaKey: true }))
}

/** Lets a settled window-open promise run its fallback continuation. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  dispatchDeepLink.mockReset()
  openDeepLinkInNewWindow.mockReset().mockResolvedValue(true)
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  followDeepLink = null
})

describe('useFollowDeepLink', () => {
  it('falls back to in-window dispatch when the window open is declined', async () => {
    openDeepLinkInNewWindow.mockResolvedValue(false)
    await render(<Harness />)

    modifierClick()

    await vi.waitFor(() =>
      expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/older'),
    )
  })

  it('falls back to in-window dispatch when the window open rejects', async () => {
    openDeepLinkInNewWindow.mockRejectedValue(new Error('window creation failed'))
    await render(<Harness />)

    modifierClick()

    await vi.waitFor(() =>
      expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/older'),
    )
  })

  it('drops a failed fallback after a newer router navigation', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openDeepLinkInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await render(<Harness />)

    modifierClick()
    expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/older')
    await view.getByRole('button', { name: 'Navigate away' }).click()
    finishOpen(false)
    await settle()

    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('drops a failed fallback after a newer note-link window intent', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openDeepLinkInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await render(<Harness />)

    modifierClick()
    expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/older')
    await view.getByRole('button', { name: 'Open newer note link' }).click({
      modifiers: ['Meta'],
    })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    finishOpen(false)
    await settle()

    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('drops a rejected fallback after a newer note-link window intent', async () => {
    let rejectOpen: (cause: Error) => void = () => {}
    openDeepLinkInNewWindow.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectOpen = reject
      }),
    )
    const view = await render(<Harness />)

    modifierClick()
    expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/older')
    await view.getByRole('button', { name: 'Open newer note link' }).click({
      modifiers: ['Meta'],
    })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    rejectOpen(new Error('window creation failed'))
    await settle()

    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it.each([
    'reflect://append?text=captured',
    'reflect://task?text=captured',
    'reflect://edit-notes?content=invalid',
  ])('does not cancel a pending failed fallback for non-address URL %s', async (url) => {
    let finishOpen: (opened: boolean) => void = () => {}
    openDeepLinkInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    await render(<Harness />)

    modifierClick()
    expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/older')
    followDeepLink?.(url, new MouseEvent('click', { metaKey: true }))
    finishOpen(false)
    await settle()

    expect(openDeepLinkInNewWindow).toHaveBeenCalledTimes(1)
    expect(dispatchDeepLink.mock.calls).toEqual([
      [url],
      ['reflect://note/older'],
    ])
  })

  it.each(['reflect://today', 'reflect://note/newer'])(
    'cancels a pending failed fallback for newer address URL %s',
    async (url) => {
      let finishOpen: (opened: boolean) => void = () => {}
      openDeepLinkInNewWindow.mockReturnValue(
        new Promise((resolve) => {
          finishOpen = resolve
        }),
      )
      await render(<Harness />)

      modifierClick()
      expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/older')
      followDeepLink?.(url)
      finishOpen(false)
      await settle()

      expect(dispatchDeepLink).toHaveBeenCalledTimes(1)
      expect(dispatchDeepLink).toHaveBeenCalledWith(url)
    },
  )

  it('drops a failed fallback after its rendered-link host unmounts', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openDeepLinkInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await render(<Harness />)

    modifierClick()
    expect(openDeepLinkInNewWindow).toHaveBeenCalledWith('reflect://note/older')
    await view.rerender(<Harness showHost={false} />)
    finishOpen(false)
    await settle()

    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })
})
