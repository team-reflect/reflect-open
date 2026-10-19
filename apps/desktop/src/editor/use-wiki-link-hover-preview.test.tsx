import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ImageUrlResolver, WikiEmbedResolver, WikilinkHoverHit } from '@meowdown/core'
import {
  createTestCoreServices,
  type TestCoreServices,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { renderHookInApp, renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useWikiLinkHoverPreview } from './use-wiki-link-hover-preview.tsx'

const markdownPreview = vi.hoisted(() => vi.fn())

interface MarkdownPreviewProps {
  content: string
  interactive: boolean
  resolveImageUrl: ImageUrlResolver
  resolveWikiEmbed: WikiEmbedResolver
}

vi.mock('@/editor/markdown-preview.tsx', () => ({
  MarkdownPreview: (props: MarkdownPreviewProps) => {
    markdownPreview(props)
    return <div data-testid="markdown-preview">{props.content}</div>
  },
}))

function hoverHit(target: string): WikilinkHoverHit {
  return { target, from: 0, to: 0, element: document.createElement('span') }
}

let app: TestCoreServices

async function setupRenderer(
  graph: TestOpenGraph | null = { generation: 7 },
): Promise<(hit: WikilinkHoverHit) => Promise<ReactNode>> {
  const { result } = await renderHookInApp(() => useWikiLinkHoverPreview({ dateFormat: 'mdy' }), {
    app,
    graph,
  })
  return result.current
}

describe('useWikiLinkHoverPreview', () => {
  beforeEach(() => {
    app = createTestCoreServices({ database: createWasmTestDatabaseService() })
    markdownPreview.mockReset()
  })

  afterEach(() => {
    app.database.close()
  })

  it('resolves null without touching the graph when no graph session is open', async () => {
    app.noteFile.set('notes/alpha.md', '# Alpha')
    const renderBody = await setupRenderer(null)

    await expect(renderBody(hoverHit('Alpha'))).resolves.toBeNull()
    expect(app.noteLinkResolver.calls()).toEqual([])
  })

  it('resolves null for a target that does not resolve to one note', async () => {
    app.noteFile.set('notes/alpha.md', '# Alpha')
    app.noteFile.set('notes/alpha-2.md', '# Alpha')
    const renderBody = await setupRenderer()

    await expect(renderBody(hoverHit('Missing'))).resolves.toBeNull()
    await expect(renderBody(hoverHit('Alpha'))).resolves.toBeNull()
    expect(app.noteLinkResolver.calls().map((call) => call.result.kind)).toEqual([
      'missing',
      'ambiguous',
    ])
  })

  it('renders a passive frontmatter-free body for a resolved target', async () => {
    app.noteFile.set('notes/alpha.md', '---\nprivate: true\n---\n# Alpha\n\nBody')
    const renderBody = await setupRenderer()

    const screen = await renderInApp(<>{await renderBody(hoverHit('Alpha'))}</>, { app })

    expect(screen.getByTestId('markdown-preview').element().textContent).toBe('# Alpha\n\nBody')
    expect(markdownPreview.mock.calls.at(-1)?.[0]).toMatchObject({
      content: '# Alpha\n\nBody',
      interactive: false,
    })
    expect(app.noteLinkResolver.calls()).toMatchObject([
      { kind: 'wiki', target: 'Alpha', generation: 7 },
    ])
  })

  it("hands the preview the target note's image and embed resolvers", async () => {
    app.attachments.setCatalog([{ path: 'attachments/garden-budget.png', size: 1 }])
    app.noteFile.set('Projects/Garden redesign.md', '# Garden redesign\n\n![[garden-budget.png]]')
    const renderBody = await setupRenderer()

    await renderInApp(<>{await renderBody(hoverHit('/Projects/Garden redesign'))}</>, { app })

    const props = markdownPreview.mock.calls.at(-1)?.[0] as MarkdownPreviewProps
    expect(await props.resolveImageUrl('../attachments/garden-budget.png')).toBe(
      `reflect-asset://localhost/${encodeURIComponent('7/attachments/garden-budget.png')}?reflect-preview=raster`,
    )
    const embed = { target: 'garden-budget.png', display: '', width: null, height: null }
    expect(props.resolveWikiEmbed(embed)).toEqual({ kind: 'image', src: 'garden-budget.png' })
    expect(props.resolveWikiEmbed({ ...embed, target: 'Deep Work' })).toEqual({ kind: 'note' })
  })

  it('shows a formatted subject and Empty note for an empty daily note', async () => {
    app.noteFile.set('daily/2026-06-09.md', '---\nid: day\n---\n\n')
    const renderBody = await setupRenderer()

    const screen = await renderInApp(<>{await renderBody(hoverHit('2026-06-09'))}</>, { app })

    expect(screen.getByText('Tue, June 9th, 2026').query()).not.toBeNull()
    expect(screen.getByText('Empty note').query()).not.toBeNull()
    expect(markdownPreview).not.toHaveBeenCalled()
  })
})
