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

async function renderSection(): Promise<void> {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  vi.spyOn(app.indexQuery, 'listTemplates').mockResolvedValue([
    { path: 'templates/weekly-review.md', title: 'Weekly review', mtime: 1 },
  ])
  await renderInApp(
    <>
      <TemplatesSection />
      <RouteProbe />
    </>,
    {
      app,
      appServices: { window: createTestWindowService({ openNoteWindow }) },
      graph: { root: '/g', name: 'g' },
      route: { kind: 'settings' },
      wrapper: (children) => <NoteTemplatesProvider>{children}</NoteTemplatesProvider>,
    },
  )
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
