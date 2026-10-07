import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectHostDialog } from './connect-host-dialog.tsx'

const sync = vi.hoisted(() => ({ connectHost: vi.fn(async () => {}) }))
vi.mock('@/providers/sync-provider.tsx', () => ({ useSync: () => sync }))

afterEach(async () => {
  await cleanup()
  vi.resetAllMocks()
  sync.connectHost.mockResolvedValue(undefined)
})

async function fillAndConnect(url: string): Promise<void> {
  await page.getByLabelText('Repository URL').fill(url)
  await page.getByLabelText('Username').fill(' alex ')
  await page.getByLabelText('Token').fill('glpat-123')
  await page.getByRole('button', { name: 'Connect' }).click()
}

describe('ConnectHostDialog', () => {
  it('connects with the trimmed URL and sign-in, then closes', async () => {
    const onClose = vi.fn()
    await render(<ConnectHostDialog onClose={onClose} />)

    await fillAndConnect(' https://gitlab.com/alex/notes.git ')

    await vi.waitFor(() =>
      expect(sync.connectHost).toHaveBeenCalledWith('https://gitlab.com/alex/notes.git', {
        username: 'alex',
        secret: 'glpat-123',
      }),
    )
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('refuses a non-HTTPS URL before touching anything', async () => {
    await render(<ConnectHostDialog onClose={vi.fn()} />)

    await fillAndConnect('git@gitlab.com:alex/notes.git')

    await expect.element(page.getByText('Enter the repository’s https:// URL.')).toBeVisible()
    expect(sync.connectHost).not.toHaveBeenCalled()
  })

  it('shows the host’s answer when the sign-in is refused and stays open', async () => {
    sync.connectHost.mockRejectedValueOnce(new Error('unexpected http status code: 401'))
    const onClose = vi.fn()
    await render(<ConnectHostDialog onClose={onClose} />)

    await fillAndConnect('https://gitlab.com/alex/notes.git')

    await expect.element(page.getByText(/401/)).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
  })
})
