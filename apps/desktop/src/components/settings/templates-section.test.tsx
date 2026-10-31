import type { MaybePromise } from '@reflect/utils'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { createTestWindowService } from '@reflect/app/testing'
import { createTestCoreServices } from '@reflect/core/testing'
import { deepLinkForRoute } from '@reflect/app'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { TemplatesSection } from './templates-section.tsx'

const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return (
    <output data-testid="route">
      {route.kind === 'note' ? `${route.kind}:${route.path}` : route.kind}
    </output>
  )
}

async function renderSection(): Promise<ReturnType<typeof createTestCoreServices>> {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  vi.spyOn(core.indexQuery, 'listTemplates').mockResolvedValue([
    { path: 'templates/weekly-review.md', title: 'Weekly review', mtime: 1 },
  ])
  await renderInApp(
    <>
      <TemplatesSection />
      <RouteProbe />
    </>,
    {
      core,
      appServices: { window: createTestWindowService({ openNoteWindow }) },
      graph: { root: '/g', name: 'g' },
      route: { kind: 'settings' },
      wrapper: (children) => <NoteTemplatesProvider>{children}</NoteTemplatesProvider>,
    },
  )
  return core
}

beforeEach(() => {
  openNoteWindow.mockReset().mockResolvedValue(true)
})

describe('TemplatesSection note links', () => {
  it('opens a template in the current window on a plain click', async () => {
    await renderSection()

    await userEvent.click(page.getByText('templates/weekly-review.md'))

    await expect
      .element(page.getByTestId('route'))
      .toMatchTextContent('note:templates/weekly-review.md')
    expect(openNoteWindow).not.toHaveBeenCalled()
  })

  it('opens a ⌘-clicked template in a new window with its explicit note route', async () => {
    await renderSection()

    await page.getByText('templates/weekly-review.md').click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() => {
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({
          kind: 'note',
          path: 'templates/weekly-review.md',
        }),
      )
    })
    expect(page.getByTestId('route').element().textContent).toBe('settings')
  })
})

describe('TemplatesSection dialogs', () => {
  it('ignores a second delete click while the first is still trashing', async () => {
    const core = await renderSection()
    const { promise, resolve } = Promise.withResolvers<void>()
    const trashOne = vi.spyOn(core.noteActions, 'trashOne').mockReturnValue(promise)

    await userEvent.click(page.getByRole('button', { name: 'Delete Weekly review' }))
    await userEvent.click(page.getByRole('button', { name: 'Delete', exact: true }))

    const pendingButton = page.getByRole('button', { name: 'Deleting…' })
    await expect.element(pendingButton).toBeDisabled()
    pendingButton.element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(trashOne).toHaveBeenCalledTimes(1)

    resolve()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(trashOne).toHaveBeenCalledTimes(1)
  })

  it('disables Rename while the rename is in flight', async () => {
    const core = await renderSection()
    const { promise, resolve } = Promise.withResolvers<string>()
    const renameTemplate = vi.spyOn(core.templates, 'renameTemplate').mockReturnValue(promise)

    await userEvent.click(page.getByRole('button', { name: 'Rename Weekly review' }))
    await userEvent.fill(page.getByRole('textbox', { name: 'Template name' }), 'Daily review')
    await userEvent.click(page.getByRole('button', { name: 'Rename', exact: true }))

    await expect.element(page.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()
    // Enter in the field is an implicit submit; a disabled submit button blocks it.
    await userEvent.type(page.getByRole('textbox', { name: 'Template name' }), '{Enter}')
    expect(renameTemplate).toHaveBeenCalledTimes(1)

    resolve('templates/daily-review.md')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })
})
