import { createTestAppServices, type TestAppServices } from '@reflect/app/testing'
import type { ReactElement } from 'react'
import { page } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import {
  createTestDatabaseService,
  createTestCoreServices,
  type TestCoreServices,
} from '@reflect/core/testing'
import { NoteTemplatesProvider, useNoteTemplates } from '@/providers/note-templates-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { TemplateCreateDialog } from './template-create-dialog.tsx'

function Opener(): ReactElement {
  const { openTemplateCreate } = useNoteTemplates()
  return (
    <button type="button" onClick={openTemplateCreate}>
      Open template dialog
    </button>
  )
}

async function renderDialog(): Promise<{ core: TestCoreServices; appLayer: TestAppServices }> {
  const core = createTestCoreServices({ database: createTestDatabaseService() })
  const appLayer = createTestAppServices(core)
  await renderInApp(
    <NoteTemplatesProvider>
      <Opener />
      <TemplateCreateDialog />
    </NoteTemplatesProvider>,
    { core, appServices: appLayer, graph: { root: '/g', name: 'g', generation: 1 } },
  )
  return { core, appLayer }
}

async function openDialog(): Promise<void> {
  await page.getByRole('button', { name: 'Open template dialog' }).click()
  await expect.element(page.getByRole('dialog', { name: 'New template' })).toBeInTheDocument()
}

async function closeAndWaitForExit(): Promise<void> {
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect.element(page.getByRole('dialog', { name: 'New template' })).not.toBeInTheDocument()
}

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
  await expect.element(page.getByRole('alert')).toMatchTextContent('Enter a name.')
  await closeAndWaitForExit()

  await openDialog()
  await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
})

it('starts empty after a successful create, and drops a stale submit error', async () => {
  const { core, appLayer } = await renderDialog()
  vi.spyOn(core.noteFile, 'write').mockRejectedValueOnce(new Error('disk full'))
  await openDialog()

  // First attempt fails and surfaces the submit error inline.
  await page.getByPlaceholder('Template name').fill('Meeting notes')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect.element(page.getByText('disk full')).toBeInTheDocument()

  // Second attempt succeeds: the dialog closes and navigates.
  await page.getByRole('button', { name: 'Create' }).click()
  await expect.element(page.getByRole('dialog', { name: 'New template' })).not.toBeInTheDocument()
  expect(appLayer.navigation.get().route).toEqual({
    kind: 'note',
    path: 'templates/meeting-notes.md',
  })
  expect(core.noteFile.writes()).toEqual([
    {
      path: 'templates/meeting-notes.md',
      contents: '---\ntitle: Meeting notes\n---\n\n',
      generation: 1,
    },
  ])

  await openDialog()
  await expect.element(page.getByPlaceholder('Template name')).toHaveValue('')
  await expect.element(page.getByText('disk full')).not.toBeInTheDocument()
})
