import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FileClickHandler,
  FileInfoResolver,
  FileLinkResolver,
  WikiEmbedResolver,
} from '@meowdown/core'
import { MarkdownPreview } from './markdown-preview'

interface CapturedMarkdownViewProps {
  readonly resolveImageUrl?: (src: string) => string | undefined
  readonly resolveFileLink?: FileLinkResolver
  readonly resolveWikiEmbed?: WikiEmbedResolver
  readonly resolveFileInfo?: FileInfoResolver
  readonly onFileClick?: FileClickHandler
}

const captured = vi.hoisted(() => ({ props: null as CapturedMarkdownViewProps | null }))

vi.mock('@meowdown/react', () => ({
  MarkdownView: (props: CapturedMarkdownViewProps) => {
    captured.props = props
    return <div data-testid="markdown-view" />
  },
}))

vi.mock('@/editor/open-external-link', () => ({
  useOpenExternalLink: () => vi.fn(),
}))

afterEach(() => {
  cleanup()
  captured.props = null
})

describe('MarkdownPreview resolver invalidation', () => {
  it('gives MarkdownView a new resolver when the backing catalog revision changes', () => {
    let resolved = 'asset://old'
    const resolver = vi.fn(() => resolved)
    const view = render(
      <MarkdownPreview content="![](photo.png)" resolveImageUrl={resolver} resolverRevision={1} />,
    )
    const first = captured.props?.resolveImageUrl
    expect(first?.('photo.png')).toBe('asset://old')

    resolved = 'asset://new'
    view.rerender(
      <MarkdownPreview content="![](photo.png)" resolveImageUrl={resolver} resolverRevision={2} />,
    )
    const second = captured.props?.resolveImageUrl
    expect(second).not.toBe(first)
    expect(second?.('photo.png')).toBe('asset://new')
  })

  it('versions every attachment resolver and forwards file clicks to the latest handler', async () => {
    const resolveFileLink = vi.fn(() => true)
    const resolveWikiEmbed = vi.fn(() => ({ kind: 'file' as const }))
    const resolveFileInfo = vi.fn(() => ({ size: 42 }))
    const firstFileClick = vi.fn<FileClickHandler>()
    const secondFileClick = vi.fn<FileClickHandler>()
    const view = render(
      <MarkdownPreview
        content="[Manual](../Media/manual.pdf)"
        resolveFileLink={resolveFileLink}
        resolveWikiEmbed={resolveWikiEmbed}
        resolveFileInfo={resolveFileInfo}
        onFileClick={firstFileClick}
        resolverRevision={1}
      />,
    )
    const firstResolvers = {
      fileLink: captured.props?.resolveFileLink,
      wikiEmbed: captured.props?.resolveWikiEmbed,
      fileInfo: captured.props?.resolveFileInfo,
    }
    const stableFileClick = captured.props?.onFileClick
    const payload = {
      href: '../Media/manual.pdf',
      name: 'Manual',
      event: new MouseEvent('click'),
    }
    stableFileClick?.(payload)
    expect(firstFileClick).toHaveBeenCalledWith(payload)

    view.rerender(
      <MarkdownPreview
        content="[Manual](../Media/manual.pdf)"
        resolveFileLink={resolveFileLink}
        resolveWikiEmbed={resolveWikiEmbed}
        resolveFileInfo={resolveFileInfo}
        onFileClick={secondFileClick}
        resolverRevision={2}
      />,
    )

    expect(captured.props?.resolveFileLink).not.toBe(firstResolvers.fileLink)
    expect(captured.props?.resolveWikiEmbed).not.toBe(firstResolvers.wikiEmbed)
    expect(captured.props?.resolveFileInfo).not.toBe(firstResolvers.fileInfo)
    expect(captured.props?.onFileClick).toBe(stableFileClick)
    expect(captured.props?.resolveFileLink?.({ href: payload.href, label: 'Manual', title: '' })).toBe(
      true,
    )
    expect(
      captured.props?.resolveWikiEmbed?.({
        target: '../Media/manual.pdf',
        display: '',
        width: null,
        height: null,
      }),
    ).toEqual({ kind: 'file' })
    expect(await captured.props?.resolveFileInfo?.(payload.href)).toEqual({ size: 42 })
    captured.props?.onFileClick?.(payload)
    expect(secondFileClick).toHaveBeenCalledWith(payload)
  })
})
