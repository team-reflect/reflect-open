import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const graphState = vi.hoisted((): { graph: import('@reflect/core').GraphInfo | null } => ({
  graph: null,
}))
const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/providers/graph-provider', () => ({ useGraph: () => graphState }))
vi.mock('@/routing/router', () => ({ useRouter: () => ({ navigate }) }))

const { NewNoteButton } = await import('./new-note-button')

afterEach(() => {
  cleanup()
  graphState.graph = null
  navigate.mockReset()
})

describe('NewNoteButton', () => {
  it('is disabled while no graph is available', () => {
    const view = render(<NewNoteButton />)
    const button = view.getByRole('button', { name: /new note/i })

    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(navigate).not.toHaveBeenCalled()
  })
})
