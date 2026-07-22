import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearOutline, publishOutline } from '@/editor/note-outline-store'
import { OutlineSection } from './outline-section'

// jsdom doesn't implement scrollIntoView; the active row scrolls on mount.
Element.prototype.scrollIntoView ??= () => {}

const revealHeading = vi.fn(() => true)

vi.mock('@/editor/editor-handle-registry', () => ({
  noteEditorHandleFor: () => ({ revealHeading }),
}))

vi.mock('./use-active-heading', () => ({
  useActiveHeading: () => 0,
}))

const NOTE = 'notes/a.md'

afterEach(() => {
  cleanup()
  clearOutline(NOTE)
  vi.clearAllMocks()
})

describe('OutlineSection', () => {
  it('shows the placeholder when the note has no headings', () => {
    render(<OutlineSection path={NOTE} />)
    expect(screen.getByText('No headings')).toBeDefined()
  })

  it('renders one row per heading and navigates on click', async () => {
    publishOutline(NOTE, [
      { level: 1, text: 'Title', slug: 'title', from: 0, to: 1 },
      { level: 2, text: 'Section', slug: 'section', from: 2, to: 3 },
    ])
    render(<OutlineSection path={NOTE} />)
    expect(screen.getByRole('button', { name: 'Title' })).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: 'Section' }))
    expect(revealHeading).toHaveBeenCalledWith('Section')
  })

  it('marks the active row with aria-current', () => {
    publishOutline(NOTE, [
      { level: 1, text: 'Title', slug: 'title', from: 0, to: 1 },
      { level: 2, text: 'Section', slug: 'section', from: 2, to: 3 },
    ])
    render(<OutlineSection path={NOTE} />)
    expect(screen.getByRole('button', { name: 'Title' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Section' }).getAttribute('aria-current')).toBeNull()
  })
})
