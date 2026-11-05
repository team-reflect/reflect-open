import { createTestAppServices } from '@reflect/app/testing'
import type { ReactElement } from 'react'
import { page, userEvent } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import { createTestCoreServices, seedNotes } from '@reflect/core/testing'
import type { CommandContext } from '@/lib/commands/types.ts'
import { NoteTemplatesProvider, useNoteTemplates } from '@/providers/note-templates-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { TemplateCreateDialog } from './template-create-dialog.tsx'
import { TemplatePicker } from './template-picker.tsx'

function Opener(): ReactElement {
  const { openTemplatePicker } = useNoteTemplates()
  return (
    <button type="button" onClick={openTemplatePicker}>
      Open template picker
    </button>
  )
}

async function renderPicker(): Promise<void> {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  seedNotes(core.database, [
    { path: 'templates/journal.md', markdown: '# Journal\n' },
    { path: 'templates/person.md', markdown: '# Person\n' },
  ])
  const context: CommandContext = {
    services: core,
    app: createTestAppServices(core),
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    clearScrollState: vi.fn(),
    togglePin: vi.fn(() => {}),
    togglePrivate: vi.fn(() => {}),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    openNoteFind: vi.fn(),
    findNextInNote: vi.fn(),
    findPreviousInNote: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
  }
  await renderInApp(
    <NoteTemplatesProvider>
      <Opener />
      <TemplatePicker context={context} />
      <TemplateCreateDialog context={context} />
    </NoteTemplatesProvider>,
    { core, graph: { root: '/g', name: 'g' } },
  )
}

async function openPicker(): Promise<void> {
  await page.getByRole('button', { name: 'Open template picker' }).click()
  await expect.element(page.getByRole('option', { name: 'Journal' })).toBeInTheDocument()
}

it('filters templates and keeps the New template row for every query', async () => {
  await renderPicker()
  await openPicker()
  await expect.element(page.getByRole('option', { name: 'Person' })).toBeInTheDocument()

  const input = page.getByPlaceholder('Insert template…')
  await input.fill('jour')
  await expect.element(page.getByRole('option', { name: 'Person' })).not.toBeInTheDocument()
  await expect.element(page.getByRole('option', { name: 'Journal' })).toBeInTheDocument()
  await expect.element(page.getByRole('option', { name: 'New template' })).toBeInTheDocument()

  await input.fill('nothing like this')
  await expect.element(page.getByText('No templates')).toBeInTheDocument()
  await expect.element(page.getByRole('option', { name: 'New template' })).toBeInTheDocument()
})

it('Enter on the only row left opens the New template dialog', async () => {
  await renderPicker()
  await openPicker()

  await page.getByPlaceholder('Insert template…').fill('nothing like this')
  await expect
    .element(page.getByRole('option', { name: 'New template' }))
    .toHaveAttribute('data-highlighted')
  await userEvent.keyboard('{Enter}')

  await expect.element(page.getByRole('dialog', { name: 'New template' })).toBeInTheDocument()
})

it('reopens with an empty query', async () => {
  await renderPicker()
  await openPicker()
  await page.getByPlaceholder('Insert template…').fill('jour')
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByPlaceholder('Insert template…')).not.toBeInTheDocument()

  await openPicker()
  await expect.element(page.getByPlaceholder('Insert template…')).toHaveValue('')
  await expect.element(page.getByRole('option', { name: 'Person' })).toBeInTheDocument()
})
