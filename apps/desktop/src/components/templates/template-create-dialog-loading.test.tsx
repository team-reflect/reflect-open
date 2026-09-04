import type { ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import type { CommandContext } from '@/lib/commands/types'
import { NoteTemplatesProvider, useNoteTemplates } from '@/providers/note-templates-provider'
import { TemplateCreateDialog } from './template-create-dialog'

const formLoad = vi.hoisted(() => {
  let finish: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { pending, finish: () => finish(), started: vi.fn() }
})

vi.mock('./template-create-form', async (importOriginal) => {
  formLoad.started()
  await formLoad.pending
  return await importOriginal<typeof import('./template-create-form')>()
})
vi.mock('@/lib/note-templates', () => ({ createTemplate: vi.fn() }))

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

function Opener(): ReactElement {
  const { openTemplateCreate } = useNoteTemplates()
  return (
    <button type="button" onClick={openTemplateCreate}>
      New template
    </button>
  )
}

it('waits for opening, dismisses while loading, and focuses the form on first use and revisit', async () => {
  await render(
    <NoteTemplatesProvider>
      <Opener />
      <TemplateCreateDialog context={context} />
    </NoteTemplatesProvider>,
  )
  expect(formLoad.started).not.toHaveBeenCalled()

  const opener = page.getByRole('button', { name: 'New template', exact: true })
  // WebKit pointer clicks do not focus buttons; enter from a keyboard-focused
  // control so the focus-return contract is the same on both engines.
  opener.element().focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('status')).toHaveTextContent('Loading…')
  expect(formLoad.started).toHaveBeenCalledTimes(1)

  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(opener).toHaveFocus()
  formLoad.finish()
  await expect.element(opener).toHaveFocus()

  await userEvent.keyboard('{Enter}')
  const name = page.getByPlaceholder('Template name')
  await expect.element(name).toHaveFocus()
  await userEvent.keyboard('Weekly review')
  await expect.element(name).toHaveValue('Weekly review')
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(opener).toHaveFocus()

  await userEvent.keyboard('{Enter}')
  await expect.element(name).toHaveFocus()
  await expect.element(name).toHaveValue('')
  expect(formLoad.started).toHaveBeenCalledTimes(1)
})
