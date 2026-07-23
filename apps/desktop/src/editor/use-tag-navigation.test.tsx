import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { useTagNavigation } from './use-tag-navigation'

let lastHandler: ((tag: string) => void) | null = null

function Host(): ReactNode {
  lastHandler = useTagNavigation()
  return null
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderHost() {
  return render(
    <RouterProvider>
      <Host />
      <RouteProbe />
    </RouterProvider>,
  )
}

function currentRoute(view: Awaited<ReturnType<typeof renderHost>>): string {
  return view.getByTestId('route').element().textContent ?? ''
}

describe('useTagNavigation', () => {
  it('opens All Notes filtered by the clicked tag', async () => {
    const view = await renderHost()
    lastHandler?.('book')
    await vi.waitFor(() => {
      expect(JSON.parse(currentRoute(view))).toEqual({ kind: 'allNotes', tag: 'book' })
    })
    await view.unmount()
  })
})
