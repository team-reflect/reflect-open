import { describe, expect, it, vi } from 'vitest'
import { createRef, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { useTagNavigation, type TagNavigation } from './use-tag-navigation.ts'

const lastHandlerRef: RefObject<TagNavigation | null> = createRef()

function Host(): ReactNode {
  const lastHandler = useTagNavigation()

  useLayoutEffect(() => {
    lastHandlerRef.current = lastHandler
    return () => {
      lastHandlerRef.current = null
    }
  }, [lastHandler])

  return null
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderHost() {
  return renderInApp(
    <>
      <Host />
      <RouteProbe />
    </>,
  )
}

function currentRoute(view: Awaited<ReturnType<typeof renderHost>>): string {
  return view.getByTestId('route').element().textContent ?? ''
}

describe('useTagNavigation', () => {
  it('opens All Notes filtered by the clicked tag', async () => {
    const view = await renderHost()
    lastHandlerRef.current?.('book')
    await vi.waitFor(() => {
      expect(JSON.parse(currentRoute(view))).toEqual({ kind: 'allNotes', tag: 'book' })
    })
  })
})
