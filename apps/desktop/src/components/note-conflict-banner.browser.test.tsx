import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { NoteConflictBanner } from './note-conflict-banner'

async function renderBanner() {
  const onKeepMine = vi.fn()
  const onLoadTheirs = vi.fn()
  const view = await render(
    <NoteConflictBanner onKeepMine={onKeepMine} onLoadTheirs={onLoadTheirs} />,
  )
  return { view, onKeepMine, onLoadTheirs }
}

describe('NoteConflictBanner', () => {
  it('explains the conflict and offers both resolutions', async () => {
    const { view } = await renderBanner()
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('This note changed on disk while you had unsaved edits.')
    await expect.element(view.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Load theirs' })).toBeInTheDocument()
  })

  it('fires onKeepMine when keeping the editor buffer', async () => {
    const { view, onKeepMine, onLoadTheirs } = await renderBanner()
    await userEvent.click(view.getByRole('button', { name: 'Keep mine' }))
    expect(onKeepMine).toHaveBeenCalledOnce()
    expect(onLoadTheirs).not.toHaveBeenCalled()
  })

  it('fires onLoadTheirs when loading the external content', async () => {
    const { view, onKeepMine, onLoadTheirs } = await renderBanner()
    await userEvent.click(view.getByRole('button', { name: 'Load theirs' }))
    expect(onLoadTheirs).toHaveBeenCalledOnce()
    expect(onKeepMine).not.toHaveBeenCalled()
  })
})
