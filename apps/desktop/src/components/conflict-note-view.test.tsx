import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import { ConflictNoteView } from './conflict-note-view'

const CONFLICTED = [
  '# Standup',
  '',
  "<<<<<<< Alex's MacBook Pro",
  '- mac line',
  '=======',
  '- phone line',
  ">>>>>>> Alex's iPhone",
  'outro',
  '',
].join('\n')

describe('ConflictNoteView', () => {
  it('renders both sides labeled by device, without raw marker lines', async () => {
    const screen = await render(<ConflictNoteView content={CONFLICTED} />)

    await expect.element(screen.getByText("Alex's MacBook Pro")).toBeInTheDocument()
    await expect.element(screen.getByText("Alex's iPhone")).toBeInTheDocument()
    await expect.element(screen.getByText(/mac line/)).toBeInTheDocument()
    await expect.element(screen.getByText(/phone line/)).toBeInTheDocument()
    // Surrounding text stays verbatim; the marker syntax becomes chrome.
    await expect.element(screen.getByText(/# Standup/)).toBeInTheDocument()
    await expect.element(screen.getByText(/outro/)).toBeInTheDocument()
    expect(screen.getByText(/<<<<<<</).query()).toBeNull()
    expect(screen.getByText(/=======/).query()).toBeNull()
  })

  it('marks an empty side instead of collapsing it', async () => {
    const stacked = '<<<<<<< Mac\nmac\n=======\nphone\n>>>>>>> iPhone\n<<<<<<< Mac\n=======\nipad\n>>>>>>> iPad\n'
    const screen = await render(<ConflictNoteView content={stacked} />)

    await expect.element(screen.getByText('Empty on this side')).toBeInTheDocument()
    await expect.element(screen.getByText(/ipad/)).toBeInTheDocument()
  })

  it('shows an unterminated block verbatim rather than styling it', async () => {
    const screen = await render(<ConflictNoteView content={'before\n<<<<<<< this device\nkept line'} />)

    await expect.element(screen.getByText(/<<<<<<< this device/)).toBeInTheDocument()
    await expect.element(screen.getByText(/kept line/)).toBeInTheDocument()
  })
})
