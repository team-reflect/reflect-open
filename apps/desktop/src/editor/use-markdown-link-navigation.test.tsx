import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import {
  type MarkdownNoteLinkNavigation,
  useMarkdownLinkNavigation,
} from './use-markdown-link-navigation'

const resolveExistingMarkdownTarget = vi.hoisted(() => vi.fn())
const chooseAmbiguousNote = vi.hoisted(() => vi.fn())
const requestNoteHeadingReveal = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveExistingMarkdownTarget,
}))
vi.mock('@/editor/ambiguous-note-chooser-store', () => ({ chooseAmbiguousNote }))
vi.mock('@/editor/editor-handle-registry', () => ({ requestNoteHeadingReveal }))
vi.mock('@/lib/operations', () => ({
  startOperation: () => ({ fail: operationFail }),
}))

let handler: MarkdownNoteLinkNavigation | null = null

function Host({ generation = 4 }: { readonly generation?: number | null }): ReactNode {
  handler = useMarkdownLinkNavigation(generation, 'Projects/Today.md')
  return null
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderHost(generation: number | null = 4): ReturnType<typeof render> {
  return render(
    <RouterProvider>
      <Host generation={generation} />
      <RouteProbe />
    </RouterProvider>,
  )
}

beforeEach(() => {
  handler = null
  resolveExistingMarkdownTarget.mockReset()
  chooseAmbiguousNote.mockReset().mockResolvedValue(null)
  requestNoteHeadingReveal.mockReset()
  operationFail.mockReset()
})

afterEach(cleanup)

describe('useMarkdownLinkNavigation', () => {
  it('claims a relative Markdown note href and reveals its decoded heading', async () => {
    resolveExistingMarkdownTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'People/Ada.md',
    })
    const view = renderHost()

    expect(handler?.('../People/Ada.md#Early%20life')).toBe(true)

    await waitFor(() => expect(view.getByTestId('route').textContent).toContain('People/Ada.md'))
    expect(resolveExistingMarkdownTarget).toHaveBeenCalledWith(
      '../People/Ada.md#Early%20life',
      'Projects/Today.md',
      4,
    )
    expect(requestNoteHeadingReveal).toHaveBeenCalledWith('People/Ada.md', 'Early life', 4)
  })

  it('opens the path selected for an ambiguous unqualified href', async () => {
    resolveExistingMarkdownTarget.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['Plan.md', 'Projects/Plan.md'],
    })
    chooseAmbiguousNote.mockResolvedValue('Projects/Plan.md')
    const view = renderHost()

    expect(handler?.('Plan.md')).toBe(true)

    await waitFor(() =>
      expect(view.getByTestId('route').textContent).toContain('Projects/Plan.md'),
    )
    expect(chooseAmbiguousNote).toHaveBeenCalledWith('Plan.md', [
      'Plan.md',
      'Projects/Plan.md',
    ])
  })

  it('leaves external and unsupported file links unclaimed', () => {
    renderHost()

    expect(handler?.('https://example.com')).toBe(false)
    expect(handler?.('../assets/report.pdf')).toBe(false)
    expect(resolveExistingMarkdownTarget).not.toHaveBeenCalled()
  })

  it('claims a valid missing note href and reports the miss without creating', async () => {
    resolveExistingMarkdownTarget.mockResolvedValue({ kind: 'missing' })
    renderHost()

    expect(handler?.('./Missing.md')).toBe(true)

    await waitFor(() =>
      expect(operationFail).toHaveBeenCalledWith(
        'Couldn’t find a Markdown note matching “./Missing.md”.',
      ),
    )
  })

  it('does not claim local hrefs without a generation-pinned graph', () => {
    renderHost(null)

    expect(handler?.('./Plan.md')).toBe(false)
    expect(resolveExistingMarkdownTarget).not.toHaveBeenCalled()
  })
})
