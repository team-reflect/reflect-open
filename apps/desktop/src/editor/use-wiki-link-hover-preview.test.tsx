import { render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type {
  FileInfoResolver,
  FileLinkResolver,
  WikiEmbedResolver,
  WikilinkHoverHit,
} from '@meowdown/core'
import { useWikiLinkHoverPreview } from './use-wiki-link-hover-preview'

const mocks = vi.hoisted(() => ({
  resolveExistingWikiTarget: vi.fn(),
  readExistingNoteSource: vi.fn(),
  markdownPreview: vi.fn(),
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveExistingWikiTarget: mocks.resolveExistingWikiTarget,
}))

vi.mock('@/lib/read-existing-note-source', () => ({
  readExistingNoteSource: mocks.readExistingNoteSource,
}))

interface MarkdownPreviewProps {
  content: string
  interactive: boolean
  resolveImageUrl: (src: string) => string | null
  resolveFileLink: FileLinkResolver
  resolveWikiEmbed: WikiEmbedResolver
  resolveFileInfo: FileInfoResolver
  onFileClick?: unknown
}

vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: (props: MarkdownPreviewProps) => {
    mocks.markdownPreview(props)
    return <div data-testid="markdown-preview">{props.content}</div>
  },
}))

function hoverHit(target: string): WikilinkHoverHit {
  return { target, from: 0, to: 0, element: document.createElement('span') }
}

function setupRenderer(
  overrides: Partial<Parameters<typeof useWikiLinkHoverPreview>[0]> = {},
): (hit: WikilinkHoverHit) => Promise<ReactNode> {
  const { result } = renderHook(() =>
    useWikiLinkHoverPreview({
      generation: 7,
      graphKey: '/graph',
      dateFormat: 'mdy',
      resolverRevision: 0,
      resolveImageUrlFromSource: (_sourcePath, source) => `reflect-asset://${source}`,
      resolveAssetOpenPathFromSource: (_sourcePath, source) =>
        source.startsWith('assets/') && !source.includes('..') ? source : null,
      resolveFileLinkFromSource: () => false,
      resolveWikiEmbedFromSource: () => undefined,
      resolveFileInfoFromSource: async () => undefined,
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
    const renderBody = setupRenderer({ generation: null, graphKey: null })

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
      const renderBody = setupRenderer()
      await expect(renderBody(hoverHit('Target'))).resolves.toBeNull()
    }
    expect(mocks.readExistingNoteSource).not.toHaveBeenCalled()
  })

  it('resolves null instead of rejecting when resolution or the read fails', async () => {
    const renderBody = setupRenderer()

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
    const renderBody = setupRenderer()

    render(<>{await renderBody(hoverHit('Alpha'))}</>)

    expect(screen.getByTestId('markdown-preview').textContent).toBe('# Alpha\n\nBody')
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
    const renderBody = setupRenderer()

    render(<>{await renderBody(hoverHit('Alpha'))}</>)

    const props = mocks.markdownPreview.mock.calls.at(-1)?.[0] as MarkdownPreviewProps
    expect(props.resolveImageUrl('https://example.com/cat.png')).toBeNull()
    expect(props.resolveImageUrl('assets/../secret.png')).toBeNull()
    expect(props.resolveImageUrl('assets/vector.svg')).toBeNull()
    expect(props.resolveImageUrl('assets/cat.png')).toBe(
      'reflect-asset://assets/cat.png?reflect-preview=raster',
    )
  })

  it('binds wiki embeds and file pills to the hovered note while keeping them passive', async () => {
    mocks.resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'Projects/2026/Plan.md',
    })
    mocks.readExistingNoteSource.mockResolvedValue(
      '![[../../Media/photo.png]]\n\n[Manual](../../Media/manual.pdf)',
    )
    const resolveFileLinkFromSource = vi.fn(() => true)
    const resolveWikiEmbedFromSource = vi.fn(() => ({
      kind: 'image' as const,
      src: '/Media/photo.png',
    }))
    const resolveFileInfoFromSource = vi.fn(async () => ({ size: 84 }))
    const renderBody = setupRenderer({
      resolveFileLinkFromSource,
      resolveWikiEmbedFromSource,
      resolveFileInfoFromSource,
    })

    render(<>{await renderBody(hoverHit('Plan'))}</>)

    const props = mocks.markdownPreview.mock.calls.at(-1)?.[0] as MarkdownPreviewProps
    const filePayload = { href: '../../Media/manual.pdf', label: 'Manual', title: '' }
    expect(props.resolveFileLink(filePayload)).toBe(true)
    expect(resolveFileLinkFromSource).toHaveBeenCalledWith('Projects/2026/Plan.md', filePayload)
    const embed = {
      target: '../../Media/photo.png',
      display: '',
      width: null,
      height: null,
    }
    expect(props.resolveWikiEmbed(embed)).toEqual({
      kind: 'image',
      src: '/Media/photo.png',
    })
    expect(resolveWikiEmbedFromSource).toHaveBeenCalledWith('Projects/2026/Plan.md', embed)
    expect(await props.resolveFileInfo('../../Media/manual.pdf')).toEqual({ size: 84 })
    expect(resolveFileInfoFromSource).toHaveBeenCalledWith(
      'Projects/2026/Plan.md',
      '../../Media/manual.pdf',
    )
    expect(props.interactive).toBe(false)
    expect(props.onFileClick).toBeUndefined()
  })

  it('shows a formatted subject and Empty note for an empty daily note', async () => {
    mocks.resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    mocks.readExistingNoteSource.mockResolvedValue('---\nid: day\n---\n\n')
    const renderBody = setupRenderer()

    render(<>{await renderBody(hoverHit('2026-06-09'))}</>)

    expect(screen.getByText('Tue, June 9th, 2026')).not.toBeNull()
    expect(screen.getByText('Empty note')).not.toBeNull()
    expect(mocks.markdownPreview).not.toHaveBeenCalled()
  })
})
