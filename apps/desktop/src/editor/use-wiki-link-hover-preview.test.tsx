import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, renderHook } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import type { WikiEmbedResolver, WikilinkHoverHit } from '@meowdown/core'
import { useWikiLinkHoverPreview } from './use-wiki-link-hover-preview.tsx'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (filePath: string) => `reflect-asset://${filePath}`,
}))

const mocks = vi.hoisted(() => ({
  resolveExistingWikiTarget: vi.fn(),
  readExistingNoteSource: vi.fn(),
  markdownPreview: vi.fn(),
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveExistingWikiTarget: mocks.resolveExistingWikiTarget,
}))

vi.mock('@/lib/read-existing-note-source.ts', () => ({
  readExistingNoteSource: mocks.readExistingNoteSource,
}))

interface MarkdownPreviewProps {
  content: string
  interactive: boolean
  resolveImageUrl: (src: string) => string | null
  resolveWikiEmbed: WikiEmbedResolver
}

vi.mock('@/editor/markdown-preview.tsx', () => ({
  MarkdownPreview: (props: MarkdownPreviewProps) => {
    mocks.markdownPreview(props)
    return <div data-testid="markdown-preview">{props.content}</div>
  },
}))

function hoverHit(target: string): WikilinkHoverHit {
  return { target, from: 0, to: 0, element: document.createElement('span') }
}

async function setupRenderer(
  overrides: Partial<Parameters<typeof useWikiLinkHoverPreview>[0]> = {},
): Promise<(hit: WikilinkHoverHit) => Promise<ReactNode>> {
  const { result } = await renderHook(() =>
    useWikiLinkHoverPreview({
      generation: 7,
      graphKey: '/graph',
      dateFormat: 'mdy',
      ...overrides,
    }),
  )
  return result.current
}

describe('useWikiLinkHoverPreview', () => {
  beforeEach(() => {
    mocks.resolveExistingWikiTarget.mockReset()
    mocks.readExistingNoteSource.mockReset()
    mocks.markdownPreview.mockReset()
  })

  it('resolves null without touching the graph when no graph session is open', async () => {
    const renderBody = await setupRenderer({ generation: null, graphKey: null })

    await expect(renderBody(hoverHit('Alpha'))).resolves.toBeNull()
    expect(mocks.resolveExistingWikiTarget).not.toHaveBeenCalled()
  })

  it('resolves null for missing, ambiguous, and unavailable targets without reading', async () => {
    for (const resolution of [
      { kind: 'missing' },
      { kind: 'ambiguous', paths: ['notes/a.md', 'notes/b.md'] },
      { kind: 'unavailable', paths: ['notes/a.md'] },
    ]) {
      mocks.resolveExistingWikiTarget.mockResolvedValueOnce(resolution)
      const renderBody = await setupRenderer()
      await expect(renderBody(hoverHit('Target'))).resolves.toBeNull()
    }
    expect(mocks.readExistingNoteSource).not.toHaveBeenCalled()
  })

  it('resolves null instead of rejecting when resolution or the read fails', async () => {
    const renderBody = await setupRenderer()

    mocks.resolveExistingWikiTarget.mockRejectedValueOnce(new Error('index gone'))
    await expect(renderBody(hoverHit('Alpha'))).resolves.toBeNull()

    mocks.resolveExistingWikiTarget.mockResolvedValueOnce({
      kind: 'resolved',
      path: 'notes/alpha.md',
    })
    mocks.readExistingNoteSource.mockRejectedValueOnce({ kind: 'notFound', message: 'gone' })
    await expect(renderBody(hoverHit('Alpha'))).resolves.toBeNull()
  })

  it('renders a passive frontmatter-free body for a resolved target', async () => {
    mocks.resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/alpha.md',
    })
    mocks.readExistingNoteSource.mockResolvedValue('---\nprivate: true\n---\n# Alpha\n\nBody')
    const renderBody = await setupRenderer()

    const screen = await render(<>{await renderBody(hoverHit('Alpha'))}</>)

    expect(screen.getByTestId('markdown-preview').element().textContent).toBe('# Alpha\n\nBody')
    expect(mocks.markdownPreview.mock.calls.at(-1)?.[0]).toMatchObject({
      content: '# Alpha\n\nBody',
      interactive: false,
    })
    expect(mocks.resolveExistingWikiTarget).toHaveBeenCalledWith('Alpha', 7)
    expect(mocks.readExistingNoteSource).toHaveBeenCalledWith('notes/alpha.md', 7)
  })

  it('serves only local sniffable raster images to the preview', async () => {
    mocks.resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/alpha.md',
    })
    mocks.readExistingNoteSource.mockResolvedValue('# Alpha')
    const renderBody = await setupRenderer()

    await render(<>{await renderBody(hoverHit('Alpha'))}</>)

    const props = mocks.markdownPreview.mock.calls.at(-1)?.[0] as MarkdownPreviewProps
    expect(props.resolveImageUrl('https://example.com/cat.png')).toBeNull()
    expect(props.resolveImageUrl('../../outside.png')).toBeNull()
    expect(props.resolveImageUrl('assets/vector.svg')).toBeNull()
    expect(props.resolveImageUrl('assets/cat.png')).toBe(
      'reflect-asset://7/assets/cat.png?reflect-preview=raster',
    )
  })

  it("resolves the target note's images and embeds from its own folder", async () => {
    mocks.resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'Projects/Garden redesign.md',
    })
    mocks.readExistingNoteSource.mockResolvedValue('![[garden-budget.png]]')
    const renderBody = await setupRenderer()

    await render(<>{await renderBody(hoverHit('Garden redesign'))}</>)

    const props = mocks.markdownPreview.mock.calls.at(-1)?.[0] as MarkdownPreviewProps
    expect(props.resolveImageUrl('../attachments/garden-budget.png')).toBe(
      'reflect-asset://7/attachments/garden-budget.png?reflect-preview=raster',
    )
    const embed = { target: 'garden-budget.png', display: '', width: null, height: null }
    expect(props.resolveWikiEmbed(embed)).toEqual({ kind: 'image', src: '/garden-budget.png' })
    expect(props.resolveWikiEmbed({ ...embed, target: 'Deep Work' })).toEqual({ kind: 'note' })
  })

  it('shows a formatted subject and Empty note for an empty daily note', async () => {
    mocks.resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    mocks.readExistingNoteSource.mockResolvedValue('---\nid: day\n---\n\n')
    const renderBody = await setupRenderer()

    const screen = await render(<>{await renderBody(hoverHit('2026-06-09'))}</>)

    expect(screen.getByText('Tue, June 9th, 2026').query()).not.toBeNull()
    expect(screen.getByText('Empty note').query()).not.toBeNull()
    expect(mocks.markdownPreview).not.toHaveBeenCalled()
  })
})
