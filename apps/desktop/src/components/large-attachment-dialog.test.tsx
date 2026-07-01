import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LargeAttachmentDialog } from './large-attachment-dialog'

function pendingFor(name: string, respond = vi.fn()) {
  return { file: new File([new Uint8Array(0)], name), respond }
}

describe('LargeAttachmentDialog', () => {
  it('renders nothing without a pending file', () => {
    render(<LargeAttachmentDialog pending={null} />)
    expect(screen.queryByText('Add large file?')).toBeNull()
  })

  it('names the file, its size, and the git constraint', () => {
    const pending = {
      file: new File([new Uint8Array(0)], 'demo.mov'),
      respond: vi.fn(),
    }
    Object.defineProperty(pending.file, 'size', { value: 132 * 1024 * 1024 })
    render(<LargeAttachmentDialog pending={pending} />)
    expect(screen.queryByText('Add large file?')).not.toBeNull()
    expect(screen.queryByText(/“demo\.mov” is 132 MB/)).not.toBeNull()
    expect(screen.queryByText(/100 MB/)).not.toBeNull()
  })

  it('approves on Add file and declines on Cancel', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    const { unmount } = render(
      <LargeAttachmentDialog pending={pendingFor('a.zip', respond)} />,
    )
    await user.click(screen.getByRole('button', { name: 'Add file' }))
    expect(respond).toHaveBeenCalledWith(true)
    unmount()

    const declined = vi.fn()
    render(<LargeAttachmentDialog pending={pendingFor('a.zip', declined)} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(declined).toHaveBeenCalledWith(false)
  })
})
