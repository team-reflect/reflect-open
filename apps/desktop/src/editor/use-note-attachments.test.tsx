import { act } from '@/test-utils/act.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useNoteAttachments, type NoteAttachments } from './use-note-attachments.ts'

function assetUrl(generation: number, path: string): string {
  return `reflect-asset://localhost/${encodeURIComponent(`${generation}/${path}`)}`
}

const embed = (target: string) => ({ target, display: '', width: null, height: null })

let attachments: NoteAttachments | null = null

afterEach(() => {
  attachments = null
})

describe('useNoteAttachments', () => {
  it('resolves from the note it renders', async () => {
    const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
    app.attachments.setCatalog([
      { path: 'Projects/attachments/plan.png', size: 1 },
      { path: 'attachments/plan.png', size: 1 },
    ])
    await renderHookInApp(
      () => {
        attachments = useNoteAttachments('Projects/Plan.md')
      },
      { app, graph: { generation: 3 } },
    )

    expect(attachments?.resolveImageUrl('attachments/plan.png')).toBe(
      assetUrl(3, 'Projects/attachments/plan.png'),
    )
    expect(attachments?.resolveAttachmentPath('attachments/plan.png')).toBe(
      'Projects/attachments/plan.png',
    )
    expect(attachments?.resolveWikiEmbed(embed('Deep Work'))).toEqual({ kind: 'note' })
  })

  it('re-renders when the catalog changes', async () => {
    let renders = 0
    const { app: services } = await renderHookInApp(
      () => {
        renders += 1
        attachments = useNoteAttachments('Home.md')
      },
      { graph: { generation: 3 } },
    )
    const rendersBefore = renders
    expect(attachments?.resolveImageUrl('garden-budget.png')).toBe(assetUrl(3, 'garden-budget.png'))

    await act(() => {
      services.attachments.setCatalog([{ path: 'attachments/garden-budget.png', size: 1 }])
      services.attachments.emitCatalogChanged()
    })

    expect(renders).toBeGreaterThan(rendersBefore)
    expect(attachments?.resolveImageUrl('garden-budget.png')).toBe(
      assetUrl(3, 'attachments/garden-budget.png'),
    )
  })

  it('resolves against the new generation when the graph reopens', async () => {
    const { app } = await renderHookInApp(
      () => {
        attachments = useNoteAttachments('Home.md')
      },
      { graph: { generation: 3 } },
    )
    app.attachments.setCatalog([{ path: 'assets/cat.png', size: 1 }])
    const before = attachments

    await act(() => app.graphSession.setGraph({ generation: 4 }))

    // New resolvers, so an editor re-resolves its images.
    expect(attachments).not.toBe(before)
    expect(attachments?.resolveImageUrl('assets/cat.png')).toBe(assetUrl(4, 'assets/cat.png'))
  })

  it('resolves only remote images while no graph is open', async () => {
    await renderHookInApp(
      () => {
        attachments = useNoteAttachments('Home.md')
      },
      { graph: null },
    )

    expect(attachments?.resolveImageUrl('https://example.com/cat.png')).toBe(
      'https://example.com/cat.png',
    )
    expect(attachments?.resolveImageUrl('assets/cat.png')).toBeUndefined()
    expect(attachments?.resolveAttachmentPath('assets/cat.png')).toBeNull()
  })
})
