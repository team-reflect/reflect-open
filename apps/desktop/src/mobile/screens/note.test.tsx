import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, type ReactElement } from 'react'
import { createTestCoreServices } from '@reflect/core/testing'
import { useRouter, type NavigateOptions } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MobileNote } from './note.tsx'

const paneProps = vi.hoisted(() => ({
  autoFocus: null as boolean | null,
  className: null as string | null,
  gutterClassName: null as string | null,
}))

vi.mock('@/components/note-pane.tsx', () => ({
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

vi.mock('@/mobile/note-actions-menu.tsx', () => ({
  NoteActionsMenu: () => null,
}))

// The backlinks section has its own suite (incoming-backlinks.test.tsx).
vi.mock('@/mobile/incoming-backlinks.tsx', () => ({
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
  const navigatedRef = useRef(false)
  useEffect(() => {
    if (!navigatedRef.current) {
      navigatedRef.current = true
      navigate({ kind: 'note', path }, options)
    }
  })
  return route.kind === 'note' ? <MobileNote key={route.path} path={route.path} /> : null
}

async function renderArrival(path: string, options?: NavigateOptions): Promise<void> {
  await renderInApp(<Arrival path={path} options={options} />)
}

afterEach(() => {
  paneProps.autoFocus = null
  paneProps.className = null
  paneProps.gutterClassName = null
})

describe('MobileNote focus contract', () => {
  it('labels an existing note screen as edit note', async () => {
    await renderArrival('notes/target.md')
    await expect.element(page.getByRole('heading', { name: 'Edit note' })).toBeVisible()
  })

  it('does not autofocus a plain arrival (no keyboard on browse)', async () => {
    await renderArrival('notes/target.md')
    expect(paneProps.autoFocus).toBe(false)
  })

  it('uses the mobile note-body gutter for the editor surface', async () => {
    await renderArrival('notes/target.md')
    expect(paneProps.gutterClassName).toBe('reflect-mobile-content-gutter')
  })

  it('gives the pane a top inset (no date header above a plain note)', async () => {
    await renderArrival('notes/target.md')
    expect(paneProps.className).toContain('pt-4')
  })

  it('autofocuses a fresh untitled note (the + flow)', async () => {
    await renderArrival(createTestCoreServices().noteCreation.untitledNotePath())
    await expect.element(page.getByRole('heading', { name: 'New note' })).toBeVisible()
    expect(paneProps.autoFocus).toBe(true)
  })

  it('ignores a focusEditor arrival intent (navigation never raises the keyboard)', async () => {
    await renderArrival('notes/target.md', { focusEditor: true })
    expect(paneProps.autoFocus).toBe(false)
  })
})
