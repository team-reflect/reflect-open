import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, type ReactElement } from 'react'
import { untitledNotePath } from '@reflect/core'
import { RouterProvider, useRouter, type NavigateOptions } from '@/routing/router'
import { MobileNote } from './note'

const paneProps = vi.hoisted(() => ({
  autoFocus: null as boolean | null,
  className: null as string | null,
  gutterClassName: null as string | null,
}))

vi.mock('@/components/note-pane', () => ({
  NotePane: ({
    autoFocus,
    className,
    gutterClassName,
  }: {
    autoFocus?: boolean
    className?: string
    gutterClassName?: string
  }) => {
    paneProps.autoFocus = autoFocus ?? false
    paneProps.className = className ?? null
    paneProps.gutterClassName = gutterClassName ?? null
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
  paneProps.className = null
  paneProps.gutterClassName = null
})

describe('MobileNote focus contract', () => {
  it('labels an existing note screen as edit note', () => {
    renderArrival('notes/target.md')
    expect(screen.getByRole('heading', { name: 'Edit note' })).toBeTruthy()
  })

  it('does not autofocus a plain arrival (no keyboard on browse)', () => {
    renderArrival('notes/target.md')
    expect(paneProps.autoFocus).toBe(false)
  })

  it('uses the mobile note-body gutter for the editor surface', () => {
    renderArrival('notes/target.md')
    expect(paneProps.gutterClassName).toBe('reflect-mobile-content-gutter')
  })

  it('gives the pane a top inset (no date header above a plain note)', () => {
    renderArrival('notes/target.md')
    expect(paneProps.className).toContain('pt-4')
  })

  it('autofocuses a fresh untitled note (the + flow)', () => {
    renderArrival(untitledNotePath())
    expect(screen.getByRole('heading', { name: 'New note' })).toBeTruthy()
    expect(paneProps.autoFocus).toBe(true)
  })

  it('consumes the focusEditor arrival intent (wiki-link / backlink taps)', () => {
    renderArrival('notes/target.md', { focusEditor: true })
    expect(paneProps.autoFocus).toBe(true)
  })
})
