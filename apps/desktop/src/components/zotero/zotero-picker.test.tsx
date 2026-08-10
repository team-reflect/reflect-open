import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator'
import { closeZoteroPicker, openZoteroPicker } from './zotero-picker-store'
import { ZoteroPicker } from './zotero-picker'

const mocks = vi.hoisted(() => ({
  insertMarkdown: vi.fn(),
  focus: vi.fn(),
}))

vi.mock('@reflect/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reflect/core')>()
  return {
    ...actual,
    zoteroSearch: vi.fn(async (query: string) => {
      if (query.toLowerCase().includes('attention')) {
        return [
          {
            key: 'ABCD1234',
            title: 'Attention is all you need',
            creators: ['Vaswani, Ashish'],
            date: '2017-06-12',
            itemType: 'journalArticle',
            abstractNote: 'We propose a new network architecture for sequence transduction.',
            url: 'https://arxiv.org/abs/1706.03762',
          },
        ]
      }
      return []
    }),
  }
})

vi.mock('@/editor/editor-handle-registry', () => ({
  noteEditorHandleFor: (path: string) => (path === 'notes/a.md' ? mocks : null),
}))

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('ZoteroPicker', () => {
  beforeEach(() => {
    mocks.insertMarkdown.mockClear()
    mocks.focus.mockClear()
    closeZoteroPicker()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
  })

  it('searches the Zotero library and inserts the picked item as a link', async () => {
    openZoteroPicker('notes/a.md')
    await render(<ZoteroPicker />, { wrapper })
    const input = page.getByRole('combobox', { name: 'Search Zotero' })
    await expect.element(input).toHaveFocus()

    await userEvent.fill(input, 'attention')

    await expect.element(page.getByText('Attention is all you need')).toBeInTheDocument()
    await expect
      .element(page.getByText(/We propose a new network architecture/))
      .toBeInTheDocument()
    await expect.element(page.getByText('https://arxiv.org/abs/1706.03762')).toBeInTheDocument()
    await userEvent.click(page.getByRole('option', { name: /Attention is all you need/ }))

    expect(mocks.insertMarkdown).toHaveBeenCalledWith(
      '[Attention is all you need](zotero://select/library/items/ABCD1234)',
    )
    expect(mocks.focus).toHaveBeenCalled()
  })

  it('moves through results with arrow keys and picks with Enter', async () => {
    openZoteroPicker('notes/a.md')
    await render(<ZoteroPicker />, { wrapper })
    const input = page.getByRole('combobox', { name: 'Search Zotero' })
    await userEvent.fill(input, 'attention')

    await expect.element(page.getByText('Attention is all you need')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('{Enter}')

    expect(mocks.insertMarkdown).toHaveBeenCalledWith(
      '[Attention is all you need](zotero://select/library/items/ABCD1234)',
    )
    expect(mocks.focus).toHaveBeenCalled()
  })

  it('shows a no-results state for an unmatched query', async () => {
    openZoteroPicker('notes/a.md')
    await render(<ZoteroPicker />, { wrapper })
    await userEvent.fill(page.getByRole('combobox', { name: 'Search Zotero' }), 'nothing-matches')
    await expect.element(page.getByText('No matching items.')).toBeInTheDocument()
  })
})
