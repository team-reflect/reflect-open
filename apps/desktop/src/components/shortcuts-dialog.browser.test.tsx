import { describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ShortcutsDialog } from './shortcuts-dialog'
import { ShortcutsProvider, useShortcuts } from '@/providers/shortcuts-provider'

function OpenButton() {
  const { openShortcuts } = useShortcuts()
  return (
    <button type="button" onClick={openShortcuts}>
      open
    </button>
  )
}

async function renderDialog() {
  return render(
    <ShortcutsProvider>
      <OpenButton />
      <ShortcutsDialog />
    </ShortcutsProvider>,
  )
}

describe('ShortcutsDialog', () => {
  it('renders nothing until opened', async () => {
    await renderDialog()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists both keymap scopes from the registries', async () => {
    await renderDialog()
    await userEvent.click(page.getByRole('button', { name: 'open' }))
    await expect
      .element(page.getByRole('dialog', { name: 'Keyboard shortcuts' }))
      .toBeInTheDocument()
    // One row from each scope (derived data, so any registered binding works).
    await expect.element(page.getByText('Go to today')).toBeInTheDocument()
    await expect.element(page.getByText('Bold')).toBeInTheDocument()
    // The cheat-sheet lists itself; a user who forgot ⌘/ can re-learn it here.
    // Scope to a list row to skip the dialog title, which has the same text.
    await expect.element(page.locate('li').getByText('Keyboard shortcuts')).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    await renderDialog()
    await userEvent.click(page.getByRole('button', { name: 'open' }))
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })
})
