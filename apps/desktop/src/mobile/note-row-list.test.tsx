import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { NoteRowList, type NoteRowModel } from './note-row-list'

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy', timeFormat: '12h' } }),
}))

describe('NoteRowList', () => {
  it('renders title search matches with the snippet highlight treatment', async () => {
    const row: NoteRowModel = {
      path: 'notes/tim-maccaw.md',
      titleSegments: [
        { text: 'Tim Mac', highlighted: true },
        { text: 'Caw', highlighted: false },
      ],
      mtime: new Date(2020, 0, 1).getTime(),
      isPinned: false,
      snippet: [],
    }

    const view = await render(<NoteRowList rows={[row]} onOpen={() => {}} />)
    const match = view.getByText('Tim Mac')

    expect(match.element().tagName).toBe('MARK')
    await expect.element(match).toHaveClass('bg-primary/15')
    await expect.element(view.getByRole('button')).toHaveTextContent('Tim MacCaw')
  })
})
