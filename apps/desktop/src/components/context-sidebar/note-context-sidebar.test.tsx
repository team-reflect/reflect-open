import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RetrievalService } from '@reflect/core'
import { createTestCoreServices, createTestRetrievalService } from '@reflect/core/testing'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NoteContextSidebar } from './note-context-sidebar.tsx'

const relatedNotes = vi.fn<RetrievalService['relatedNotes']>()

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

async function renderSidebar(path: string) {
  return await renderInApp(
    <>
      <NoteContextSidebar path={path} />
      <RouteProbe />
    </>,
    {
      app: createTestCoreServices({
        database: createWasmTestDatabaseService(),
        retrieval: createTestRetrievalService({ relatedNotes }),
      }),
      graph: { root: '/g', name: 'g' },
      settings: { semanticSearchEnabled: true },
    },
  )
}

beforeEach(() => {
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('NoteContextSidebar', () => {
  it('queries the note path for similar notes and shows no section without results', async () => {
    const view = await renderSidebar('notes/rust.md')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('notes/rust.md', 6))
    expect(view.getByText('Similar notes').query()).toBeNull()
  })

  it('lists similar notes under their own section and navigates on click', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/zig.md',
        title: 'Zig',
        score: 0.8,
        snippet: 'comptime experiments',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSidebar('notes/rust.md')
    await expect.element(view.getByText('Similar notes')).toBeInTheDocument()
    await userEvent.click(view.getByText('Zig'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"note"')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/zig.md')
  })
})
