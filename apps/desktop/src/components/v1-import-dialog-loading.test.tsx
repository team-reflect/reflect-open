import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import { V1ImportDialog } from './v1-import-dialog'

const statusLoad = vi.hoisted(() => {
  let finish: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { pending, finish: () => finish(), started: vi.fn() }
})

vi.mock('./v1-import-status', async (importOriginal) => {
  statusLoad.started()
  await statusLoad.pending
  return await importOriginal<typeof import('./v1-import-status')>()
})

it('keeps import cancellation and completion controls available while details load', async () => {
  const onCancel = vi.fn()
  const onDismiss = vi.fn()
  const view = await render(
    <V1ImportDialog state={{ phase: 'idle' }} onCancel={onCancel} onDismiss={onDismiss} />,
  )
  expect(statusLoad.started).not.toHaveBeenCalled()

  await view.rerender(
    <V1ImportDialog
      state={{ phase: 'running', progress: null, cancelling: false }}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />,
  )
  await expect.element(page.getByRole('status')).toHaveTextContent('Loading…')
  await userEvent.keyboard('{Escape}')
  expect(onDismiss).not.toHaveBeenCalled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(onCancel).toHaveBeenCalledTimes(1)

  await view.rerender(
    <V1ImportDialog
      state={{
        phase: 'running',
        progress: { stage: 'writing', done: 2, total: 5 },
        cancelling: false,
      }}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />,
  )
  await expect.element(page.getByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  statusLoad.finish()
  await expect.element(page.getByText('Adding notes… 2 of 5')).toBeInTheDocument()

  await view.rerender(
    <V1ImportDialog
      state={{ phase: 'failed', message: 'Could not read the export' }}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />,
  )
  await expect.element(page.getByRole('alert')).toHaveTextContent('Could not read the export')
  await page.getByRole('button', { name: 'Close' }).click()
  expect(onDismiss).toHaveBeenCalledTimes(1)
  expect(statusLoad.started).toHaveBeenCalledTimes(1)
})
