import type { ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CommandContext } from '@/lib/commands/types'
import { NoteTemplatesProvider, useNoteTemplates } from '@/providers/note-templates-provider'
import { TemplateCreateDialog } from './template-create-dialog'

const { createTemplateMock } = vi.hoisted(() => ({ createTemplateMock: vi.fn() }))
vi.mock('@/lib/note-templates', () => ({ createTemplate: createTemplateMock }))

function Opener(): ReactElement {
  const { openTemplateCreate } = useNoteTemplates()
  return (
    <button type="button" onClick={openTemplateCreate}>
      Open template dialog
    </button>
  )
}

async function renderDialog(): Promise<CommandContext> {
  const context: CommandContext = {
    navigate: vi.fn(),
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
    graphRoot: () => '/notes',
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
  }
  await render(
    <NoteTemplatesProvider>
      <Opener />
      <TemplateCreateDialog context={context} />
    </NoteTemplatesProvider>,
  )
  return context
}

async function openDialog(): Promise<void> {
  await page.getByRole('button', { name: 'Open template dialog' }).click()
  await expect.element(page.getByRole('dialog', { name: 'New template' })).toBeInTheDocument()
}

async function closeAndWaitForExit(): Promise<void> {
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect.element(page.getByRole('dialog', { name: 'New template' })).not.toBeInTheDocument()
}

beforeEach(() => {
  createTemplateMock.mockReset()
})

it('starts empty again after cancelling a typed name', async () => {
  await renderDialog()
  await openDialog()
  await page.getByPlaceholder('Template name').fill('Weekly review')
  await closeAndWaitForExit()

  await openDialog()
  await expect.element(page.getByPlaceholder('Template name')).toHaveValue('')
})

it('drops the validation error between opens', async () => {
  await renderDialog()
  await openDialog()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect.element(page.getByRole('alert')).toHaveTextContent('Enter a name.')
  await closeAndWaitForExit()

  await openDialog()
  await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
})

it('starts empty after a successful create, and drops a stale submit error', async () => {
  createTemplateMock.mockRejectedValueOnce(new Error('disk full'))
  createTemplateMock.mockResolvedValueOnce('templates/meeting-notes.md')
  const context = await renderDialog()
  await openDialog()

  // First attempt fails and surfaces the submit error inline.
  await page.getByPlaceholder('Template name').fill('Meeting notes')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect.element(page.getByText('disk full')).toBeInTheDocument()

  // Second attempt succeeds: the dialog closes and navigates.
  await page.getByRole('button', { name: 'Create' }).click()
  await expect.element(page.getByRole('dialog', { name: 'New template' })).not.toBeInTheDocument()
  expect(context.navigate).toHaveBeenCalledWith({
    kind: 'note',
    path: 'templates/meeting-notes.md',
  })

  await openDialog()
  await expect.element(page.getByPlaceholder('Template name')).toHaveValue('')
  await expect.element(page.getByText('disk full')).not.toBeInTheDocument()
})
