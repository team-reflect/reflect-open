import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installVirtuaTestEnv } from '@/test-utils/virtua-jsdom'
import { NoteRowList, type NoteRowModel } from './note-row-list'

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy', timeFormat: '12h' } }),
}))

installVirtuaTestEnv((element) => (element.tagName === 'LI' ? 64 : 768))

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

    const view = render(<NoteRowList rows={[row]} onOpen={() => {}} />)
    const match = await view.findByText('Tim Mac')

    expect(match.tagName).toBe('MARK')
    expect(match.className).toContain('bg-primary/15')
    expect(view.getByRole('button').textContent).toContain('Tim MacCaw')
  })
})
