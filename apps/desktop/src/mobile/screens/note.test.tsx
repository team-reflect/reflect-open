import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, type ReactElement } from 'react'
import { untitledNotePath } from '@reflect/core'
import { RouterProvider, useRouter, type NavigateOptions } from '@/routing/router'
import { MobileNote } from './note'

const paneProps = vi.hoisted(() => ({ autoFocus: null as boolean | null }))

vi.mock('@/components/note-pane', () => ({
  NotePane: ({ autoFocus }: { autoFocus?: boolean }) => {
    paneProps.autoFocus = autoFocus ?? false
    return <div data-testid="fake-pane" />
  },
}))

vi.mock('@/mobile/note-actions-menu', () => ({
  NoteActionsMenu: () => null,
}))

// The backlinks section has its own suite (incoming-backlinks.test.tsx) and
// needs the query/graph providers this focus-contract harness doesn't mount.
vi.mock('@/mobile/incoming-backlinks', () => ({
  IncomingBacklinks: () => null,
}))

/**
 * Navigates to the note once (a real arrival, so the router's focus intent
 * is set exactly as a wiki-link tap would) and renders the screen the way
 * `MobileScreen` does — keyed by path.
 */
function Arrival({
  path,
  options,
}: {
  path: string
  options?: NavigateOptions | undefined
}): ReactElement | null {
  const { route, navigate } = useRouter()
  const navigated = useRef(false)
  useEffect(() => {
    if (!navigated.current) {
      navigated.current = true
      navigate({ kind: 'note', path }, options)
    }
  })
  return route.kind === 'note' ? <MobileNote key={route.path} path={route.path} /> : null
}

function renderArrival(path: string, options?: NavigateOptions): ReturnType<typeof render> {
  return render(
    <RouterProvider>
      <Arrival path={path} options={options} />
    </RouterProvider>,
  )
}

afterEach(() => {
  cleanup()
  paneProps.autoFocus = null
})

describe('MobileNote focus contract', () => {
  it('does not autofocus a plain arrival (no keyboard on browse)', () => {
    renderArrival('notes/target.md')
    expect(paneProps.autoFocus).toBe(false)
  })

  it('autofocuses a fresh untitled note (the + flow)', () => {
    renderArrival(untitledNotePath())
    expect(paneProps.autoFocus).toBe(true)
  })

  it('consumes the focusEditor arrival intent (wiki-link / backlink taps)', () => {
    renderArrival('notes/target.md', { focusEditor: true })
    expect(paneProps.autoFocus).toBe(true)
  })
})
