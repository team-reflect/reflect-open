import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceHeader } from './workspace-header'

function renderHeader(overrides: Partial<Parameters<typeof WorkspaceHeader>[0]> = {}) {
  const onToggleTheme = vi.fn()
  const onOpenSettings = vi.fn()
  const view = render(
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
  it('shows the graph name (root as tooltip) and version', () => {
    const { view } = renderHeader()
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('My Graph')
    expect(view.getByText('v1.2.3')).toBeTruthy()
    expect(view.queryByRole('status')).toBeNull()
    view.unmount()
  })

  it('shows the indexing indicator while the reconcile runs', () => {
    const { view } = renderHeader({ indexing: true })
    expect(view.getByRole('status').textContent).toBe('Indexing…')
    view.unmount()
  })

  it('offers the opposite theme and toggles on click', async () => {
    const { view, onToggleTheme } = renderHeader({ resolvedTheme: 'dark' })
    await userEvent.click(view.getByText('Light mode'))
    expect(onToggleTheme).toHaveBeenCalledOnce()
    view.unmount()
  })

  it('opens settings', async () => {
    const { view, onOpenSettings } = renderHeader()
    await userEvent.click(view.getByLabelText('Open settings'))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    view.unmount()
  })
})
