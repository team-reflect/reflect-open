import type { ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { useSuppressDefaultContextMenu } from './use-suppress-default-context-menu.ts'

interface HostProps {
  enabled: boolean
}

function Host({ enabled }: HostProps): ReactElement {
  useSuppressDefaultContextMenu(enabled)
  return (
    <div>
      <button type="button">Daily</button>
      <input aria-label="Title" />
      <div className="reflect-editor">
        <strong>Body</strong>
      </div>
      <code className="select-text">ABCD-1234</code>
    </div>
  )
}

describe('useSuppressDefaultContextMenu', () => {
  it('prevents the default menu on plain chrome', async () => {
    const view = await render(<Host enabled />)
    expect(fireEvent.contextMenu(view.getByRole('button', { name: 'Daily' }))).toBe(false)
    await view.unmount()
  })

  it('keeps the default menu inside text regions', async () => {
    const view = await render(<Host enabled />)
    expect(fireEvent.contextMenu(view.getByRole('textbox', { name: 'Title' }))).toBe(true)
    expect(fireEvent.contextMenu(view.getByText('Body'))).toBe(true)
    expect(fireEvent.contextMenu(view.getByText('ABCD-1234'))).toBe(true)
    await view.unmount()
  })

  it('keeps the default menu everywhere while disabled', async () => {
    const view = await render(<Host enabled={false} />)
    expect(fireEvent.contextMenu(view.getByRole('button', { name: 'Daily' }))).toBe(true)
    await view.unmount()
  })
})
