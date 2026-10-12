import { upsertFrontmatter } from '@reflect/core'
import { frontmatterPatchToYaml, type FrontmatterPatch } from '@/editor/note-session.ts'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { NoteAliasesSection } from './note-aliases-section.tsx'

const noteSource = vi.hoisted(() => ({ value: '# A\n' }))
const readNoteSource = vi.hoisted(() => vi.fn(async () => noteSource.value))
const commitNoteFrontmatter = vi.hoisted(() =>
  vi.fn<(path: string, patch: FrontmatterPatch, generation: number) => Promise<void>>(),
)
vi.mock('@/lib/note-frontmatter.ts', () => ({ readNoteSource, commitNoteFrontmatter }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

async function renderSection(isAdding: boolean) {
  const onAddingDone = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <NoteAliasesSection path="notes/a.md" isAdding={isAdding} onAddingDone={onAddingDone} />
      </QueryClientProvider>
    </TooltipProvider>,
  )
  return { ...view, onAddingDone }
}

beforeEach(() => {
  window.sessionStorage.clear()
  noteSource.value = '# A\n'
  readNoteSource.mockReset().mockImplementation(async () => noteSource.value)
  commitNoteFrontmatter.mockReset().mockImplementation(async (_path, patch) => {
    noteSource.value = upsertFrontmatter(noteSource.value, frontmatterPatchToYaml(patch))
  })
})

describe('NoteAliasesSection', () => {
  it('renders nothing for a note with no aliases while not adding', async () => {
    const view = await renderSection(false)
    await vi.waitFor(() => expect(readNoteSource).toHaveBeenCalled())
    expect(view.container.textContent).toBe('')
    await view.unmount()
  })

  it('lists frontmatter aliases and the title’s // segments', async () => {
    noteSource.value = '---\naliases:\n  - QBR\n---\n# Budget Review // Budget\n'
    const view = await renderSection(false)
    await expect.element(view.getByText('Note aliases')).toBeInTheDocument()
    await expect.element(view.getByText('QBR')).toBeInTheDocument()
    await expect.element(view.getByText('Budget', { exact: true })).toBeInTheDocument()
    // Title segments are edited in the H1, so only the frontmatter row is removable.
    expect(view.getByRole('button', { name: /Remove alias/ }).elements()).toHaveLength(1)
    await view.unmount()
  })

  it('adds the typed alias on Enter and closes the input', async () => {
    const view = await renderSection(true)
    const input = view.getByRole('textbox', { name: 'New alias' })
    await expect.element(input).toHaveFocus()
    await userEvent.type(input, ' QBR {Enter}')
    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { aliases: ['QBR'] }, 7),
    )
    expect(view.onAddingDone).toHaveBeenCalled()
    await view.unmount()
  })

  it('adds through the check button too', async () => {
    const view = await renderSection(true)
    await userEvent.type(view.getByRole('textbox', { name: 'New alias' }), 'QBR')
    await userEvent.click(view.getByRole('button', { name: 'Add alias' }))
    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { aliases: ['QBR'] }, 7),
    )
    await view.unmount()
  })

  it('refuses a name the note already answers to and keeps the input open', async () => {
    const view = await renderSection(true)
    await userEvent.type(view.getByRole('textbox', { name: 'New alias' }), 'a{Enter}')
    await expect.element(view.getByText('This note already has that name')).toBeInTheDocument()
    expect(commitNoteFrontmatter).not.toHaveBeenCalled()
    expect(view.onAddingDone).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('closes without writing on Escape', async () => {
    const view = await renderSection(true)
    await userEvent.type(view.getByRole('textbox', { name: 'New alias' }), 'QBR{Escape}')
    expect(view.onAddingDone).toHaveBeenCalled()
    expect(commitNoteFrontmatter).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('removes a frontmatter alias from its row action', async () => {
    noteSource.value = '---\naliases:\n  - QBR\n  - Budget\n---\n# A\n'
    const view = await renderSection(false)
    await userEvent.click(view.getByRole('button', { name: 'Remove alias QBR' }))
    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { aliases: ['Budget'] }, 7),
    )
    await expect.element(view.getByText('QBR')).not.toBeInTheDocument()
    await view.unmount()
  })
})
