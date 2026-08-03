import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import type { CommandContext } from '@/lib/commands/types'
import { NoteTemplatesProvider, useNoteTemplates } from '@/providers/note-templates-provider'
import { TemplateCreateDialog } from './template-create-dialog'

const createTemplate = vi.hoisted(() =>
  vi.fn<(name: string, generation: number) => Promise<string>>(),
)

vi.mock('@/lib/note-templates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/note-templates')>()),
  createTemplate,
}))

function OpenTemplateCreate(): ReactElement {
  const { openTemplateCreate } = useNoteTemplates()
  return <Button onClick={openTemplateCreate}>New template</Button>
}

function renderDialog(context?: Partial<CommandContext>) {
  const navigate = vi.fn()
  const fullContext: CommandContext = {
    navigate,
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    clearScrollState: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    openNoteFind: vi.fn(),
    findNextInNote: vi.fn(),
    findPreviousInNote: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => 1,
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...context,
  }
  return render(
    <NoteTemplatesProvider>
      <OpenTemplateCreate />
      <TemplateCreateDialog context={fullContext} />
    </NoteTemplatesProvider>,
  )
}

beforeEach(() => {
  createTemplate.mockReset().mockResolvedValue('templates/weekly-review.md')
})

describe('TemplateCreateDialog', () => {
  it('opens each time with an empty name, not the last one created', async () => {
    await renderDialog()

    await userEvent.click(page.getByRole('button', { name: 'New template' }))
    await userEvent.fill(page.getByPlaceholder('Template name'), 'Weekly review')
    await userEvent.click(page.getByRole('button', { name: 'Create' }))

    await vi.waitFor(() => expect(createTemplate).toHaveBeenCalledWith('Weekly review', 1))

    await userEvent.click(page.getByRole('button', { name: 'New template' }))

    await expect.element(page.getByPlaceholder('Template name')).toHaveValue('')
  })

  it('opens each time with an empty name after a cancelled draft', async () => {
    await renderDialog()

    await userEvent.click(page.getByRole('button', { name: 'New template' }))
    await userEvent.fill(page.getByPlaceholder('Template name'), 'Abandoned')
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }))

    await userEvent.click(page.getByRole('button', { name: 'New template' }))

    await expect.element(page.getByPlaceholder('Template name')).toHaveValue('')
    expect(createTemplate).not.toHaveBeenCalled()
  })

  it('drops the previous attempt error when reopened', async () => {
    createTemplate.mockRejectedValue(new Error('Disk is full'))
    await renderDialog()

    await userEvent.click(page.getByRole('button', { name: 'New template' }))
    await userEvent.fill(page.getByPlaceholder('Template name'), 'Weekly review')
    await userEvent.click(page.getByRole('button', { name: 'Create' }))

    await expect.element(page.getByText('Disk is full')).toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(page.getByRole('button', { name: 'New template' }))

    expect(page.getByText('Disk is full').query()).toBeNull()
  })
})
