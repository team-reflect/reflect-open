import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@reflect/core'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { ConnectGitHostDialog } from './connect-git-host-dialog.tsx'

// The dialog owns the three fields and the busy/error envelope only; the
// host connector (scripted here) does the probe and the connect.

const URL = 'https://gitlab.com/alex/notes.git'

async function fill(): Promise<void> {
  await userEvent.fill(page.getByLabelText('Repository address'), URL)
  await userEvent.fill(page.getByLabelText('Username'), 'alex')
  await userEvent.fill(page.getByLabelText('Access token or password'), 'glpat-1')
}

describe('ConnectGitHostDialog', () => {
  it('hands the fields to the host connector and closes once connected', async () => {
    const onClose = vi.fn()
    const { gitHostConnector } = await renderInApp(<ConnectGitHostDialog onClose={onClose} />, {
      sync: { phase: 'disconnected' },
    })

    await expect.element(page.getByRole('heading', { name: 'Other host' })).toBeVisible()
    await fill()
    await userEvent.click(page.getByRole('button', { name: 'Connect' }))

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(gitHostConnector?.calls()).toEqual([
      { method: 'connectGitHost', remoteUrl: URL, username: 'alex', token: 'glpat-1' },
    ])
  })

  it('shows a refusal inline and keeps the fields', async () => {
    const onClose = vi.fn()
    const { gitHostConnector } = await renderInApp(<ConnectGitHostDialog onClose={onClose} />, {
      sync: { phase: 'disconnected' },
    })
    gitHostConnector?.onConnectGitHost(() => {
      throw new AppError('auth', 'the host rejected the sign-in')
    })

    await fill()
    await userEvent.click(page.getByRole('button', { name: 'Connect' }))

    await expect.element(page.getByRole('alert')).toHaveTextContent('the host rejected the sign-in')
    await expect.element(page.getByLabelText('Repository address')).toHaveValue(URL)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('prefills the remote, less any sign-in in it, when a sign-in is being updated', async () => {
    await renderInApp(
      <ConnectGitHostDialog
        remoteUrl="https://alex:s3cret@gitlab.com/alex/notes.git"
        onClose={vi.fn()}
      />,
      { sync: { phase: 'disconnected' } },
    )

    await expect.element(page.getByRole('heading', { name: 'Update sign-in' })).toBeVisible()
    await expect.element(page.getByLabelText('Repository address')).toHaveValue(URL)
  })

  it('refuses an SSH address with a note and keeps Connect disabled', async () => {
    await renderInApp(<ConnectGitHostDialog onClose={vi.fn()} />, {
      sync: { phase: 'disconnected' },
    })

    await userEvent.fill(page.getByLabelText('Repository address'), 'git@gitlab.com:alex/notes.git')
    // The address is checked when the field loses focus.
    await userEvent.tab()

    await expect.element(page.getByText(/This is an SSH address/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })

  it('names the reason for a GitHub or plain-http address and keeps Connect disabled', async () => {
    await renderInApp(<ConnectGitHostDialog onClose={vi.fn()} />, {
      sync: { phase: 'disconnected' },
    })
    const address = page.getByLabelText('Repository address')

    await userEvent.fill(address, 'https://github.com/alex/notes.git')
    await userEvent.tab()
    await expect.element(page.getByText(/choose GitHub/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Connect' })).toBeDisabled()

    await userEvent.fill(address, 'http://gitea.local/alex/notes.git')
    await userEvent.tab()
    await expect.element(page.getByText(/plain http/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })

  it('locks the dialog while the connect is pending', async () => {
    const pending = Promise.withResolvers<void>()
    const onClose = vi.fn()
    const { gitHostConnector } = await renderInApp(<ConnectGitHostDialog onClose={onClose} />, {
      sync: { phase: 'disconnected' },
    })
    gitHostConnector?.onConnectGitHost(() => pending.promise)

    await fill()
    await userEvent.click(page.getByRole('button', { name: 'Connect' }))

    await expect.element(page.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()

    pending.resolve()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
