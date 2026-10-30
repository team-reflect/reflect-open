import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmActionDialog } from '@/components/confirm-action-dialog.tsx'

describe('ConfirmActionDialog', () => {
  it('closes once the action resolves', async () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    const onClose = vi.fn()
    const view = await render(
      <ConfirmActionDialog
        title="Forget graph?"
        description="Files stay on disk."
        confirmLabel="Forget graph"
        pendingLabel="Forgetting…"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )

    await userEvent.click(page.getByRole('button', { name: 'Forget graph' }))

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await view.unmount()
  })

  it('shows a failure inline and stays open', async () => {
    const onClose = vi.fn()
    const view = await render(
      <ConfirmActionDialog
        title="Delete graph?"
        description="Moves the folder to Trash."
        confirmLabel="Delete graph"
        pendingLabel="Deleting…"
        onConfirm={() => Promise.reject(new Error('Folder is locked'))}
        onClose={onClose}
      />,
    )

    await userEvent.click(page.getByRole('button', { name: 'Delete graph' }))

    await expect.element(page.getByRole('alert')).toHaveTextContent('Folder is locked')
    await expect.element(page.getByRole('button', { name: 'Delete graph' })).not.toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('ignores a second confirm and Escape while the action runs', async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const onConfirm = vi.fn(() => promise)
    const onClose = vi.fn()
    const view = await render(
      <ConfirmActionDialog
        title="Delete template?"
        description="Moves to the trash."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )

    await userEvent.click(page.getByRole('button', { name: 'Delete' }))

    const pendingButton = page.getByRole('button', { name: 'Deleting…' })
    await expect.element(pendingButton).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    pendingButton.element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await userEvent.keyboard('{Escape}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    resolve()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    await view.unmount()
  })

  it('keeps confirm dead while confirmDisabled is set', async () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    const view = await render(
      <ConfirmActionDialog
        title="Delete graph?"
        description="Type the name to confirm."
        confirmLabel="Delete graph"
        pendingLabel="Deleting…"
        confirmDisabled
        onConfirm={onConfirm}
        onClose={vi.fn()}
      >
        {({ confirm }) => (
          <button type="button" onClick={confirm}>
            Submit from child
          </button>
        )}
      </ConfirmActionDialog>,
    )

    await expect.element(page.getByRole('button', { name: 'Delete graph' })).toBeDisabled()
    await userEvent.click(page.getByRole('button', { name: 'Submit from child' }))
    expect(onConfirm).not.toHaveBeenCalled()
    await view.unmount()
  })
})
