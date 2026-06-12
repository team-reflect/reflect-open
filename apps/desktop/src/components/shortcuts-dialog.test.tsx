import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ShortcutsDialog } from './shortcuts-dialog'
import { ShortcutsProvider, useShortcuts } from '@/providers/shortcuts-provider'

afterEach(cleanup) // `globals: false` disables testing-library's automatic cleanup

function OpenButton() {
  const { openShortcuts } = useShortcuts()
  return (
    <button type="button" onClick={openShortcuts}>
      open
    </button>
  )
}

function renderDialog() {
  return render(
    <ShortcutsProvider>
      <OpenButton />
      <ShortcutsDialog />
    </ShortcutsProvider>,
  )
}

describe('ShortcutsDialog', () => {
  it('renders nothing until opened', () => {
    renderDialog()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists both keymap scopes from the registries', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: 'open' }))
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(dialog).toBeTruthy()
    // One row from each scope — derived data, so any registered binding works.
    expect(screen.getByText('Go to today')).toBeTruthy()
    expect(screen.getByText('Bold')).toBeTruthy()
    // The cheat-sheet lists itself; a user who forgot ⌘/ can re-learn it here.
    expect(screen.getByText('Keyboard shortcuts', { selector: 'li *' })).toBeTruthy()
  })

  it('closes on Escape', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: 'open' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
