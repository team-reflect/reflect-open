import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceHeader } from './workspace-header'

async function renderHeader(overrides: Partial<Parameters<typeof WorkspaceHeader>[0]> = {}) {
  const onToggleTheme = vi.fn()
  const onOpenSettings = vi.fn()
  const view = await render(
    <TooltipProvider>
      <WorkspaceHeader
        graphName="My Graph"
        graphRoot="/graphs/mine"
        indexing={false}
        version="1.2.3"
        resolvedTheme="light"
        onToggleTheme={onToggleTheme}
        onOpenSettings={onOpenSettings}
        {...overrides}
      />
    </TooltipProvider>,
  )
  return { view, onToggleTheme, onOpenSettings }
}

describe('WorkspaceHeader', () => {
  it('shows the graph name (root as tooltip) and version', async () => {
    const { view } = await renderHeader()
    expect(view.getByRole('heading', { level: 1 }).element().textContent).toBe('My Graph')
    await expect.element(view.getByText('v1.2.3')).toBeInTheDocument()
    expect(view.getByRole('status').query()).toBeNull()
    await view.unmount()
  })

  it('shows the indexing indicator while the reconcile runs', async () => {
    const { view } = await renderHeader({ indexing: true })
    expect(view.getByRole('status').element().textContent).toBe('Indexing…')
    await view.unmount()
  })

  it('offers the opposite theme and toggles on click', async () => {
    const { view, onToggleTheme } = await renderHeader({ resolvedTheme: 'dark' })
    await userEvent.click(view.getByText('Light mode'))
    expect(onToggleTheme).toHaveBeenCalledOnce()
    await view.unmount()
  })

  it('opens settings', async () => {
    const { view, onOpenSettings } = await renderHeader()
    await userEvent.click(view.getByLabelText('Open settings'))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    await view.unmount()
  })
})
