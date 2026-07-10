import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { TemplatesSection } from './templates-section'

const listTemplates = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  listTemplates,
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/note-templates-provider', () => ({
  useNoteTemplates: () => ({ openTemplateCreate: vi.fn() }),
}))

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return (
    <output data-testid="route">
      {route.kind === 'note' ? `${route.kind}:${route.path}` : route.kind}
    </output>
  )
}

function renderSection() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider initialRoute={{ kind: 'settings' }}>
        <TemplatesSection />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function templateLink(): HTMLButtonElement {
  const button = screen.getByText('templates/weekly-review.md').closest('button')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('expected the template path inside its link button')
  }
  return button
}

beforeEach(() => {
  listTemplates.mockReset().mockResolvedValue([
    { path: 'templates/weekly-review.md', title: 'Weekly review', mtime: 1 },
  ])
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

afterEach(cleanup)

describe('TemplatesSection note links', () => {
  it('opens a template in the current window on a plain click', async () => {
    renderSection()

    await userEvent.click(await screen.findByText('templates/weekly-review.md'))

    expect(screen.getByTestId('route').textContent).toBe(
      'note:templates/weekly-review.md',
    )
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
  })

  it('opens a ⌘-clicked template in a new window with its explicit note route', async () => {
    renderSection()
    await screen.findByText('templates/weekly-review.md')

    fireEvent.click(templateLink(), { metaKey: true })

    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'templates/weekly-review.md',
      }),
    )
    expect(screen.getByTestId('route').textContent).toBe('settings')
  })
})
