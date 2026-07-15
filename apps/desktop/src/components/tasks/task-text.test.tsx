import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FileInfoResolver,
  FileLinkResolver,
  WikiEmbedResolver,
} from '@meowdown/core'
import { makeOpenTask } from '@/lib/tasks/open-task-fixture'
import { TaskText } from './task-text'

interface MarkdownPreviewProps {
  readonly content: string
  readonly interactive?: boolean
  readonly resolveImageUrl?: (src: string) => string | null
  readonly resolveFileLink?: FileLinkResolver
  readonly resolveWikiEmbed?: WikiEmbedResolver
  readonly resolveFileInfo?: FileInfoResolver
  readonly resolverRevision?: number
}

const mocks = vi.hoisted(() => ({
  useAssetPersistence: vi.fn(),
  previewProps: null as MarkdownPreviewProps | null,
}))

const resolveImageUrl = (src: string): string => `asset://${src}`
const resolveFileLink: FileLinkResolver = () => true
const resolveWikiEmbed: WikiEmbedResolver = () => ({ kind: 'image' })
const resolveFileInfo: FileInfoResolver = async () => ({ size: 42 })

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/graph', name: 'Graph', generation: 9 } }),
}))

vi.mock('@/editor/use-asset-persistence', () => ({
  useAssetPersistence: (generation: number | null, path?: string) => {
    mocks.useAssetPersistence(generation, path)
    return {
      resolveImageUrl,
      resolveFileLink,
      resolveWikiEmbed,
      resolveFileInfo,
      attachmentCatalogRevision: 4,
    }
  },
}))

vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: (props: MarkdownPreviewProps) => {
    mocks.previewProps = props
    return <div data-testid="task-preview">{props.content}</div>
  },
}))

afterEach(() => {
  cleanup()
  mocks.useAssetPersistence.mockReset()
  mocks.previewProps = null
})

describe('TaskText attachments', () => {
  it('binds passive attachment rendering to the task source note', () => {
    const task = makeOpenTask({
      notePath: 'Projects/2026/Plan.md',
      raw: '[ ] Review ![[../../Media/diagram.png]]',
      text: 'Review ![[../../Media/diagram.png]]',
    })

    render(<TaskText task={task} />)

    expect(mocks.useAssetPersistence).toHaveBeenCalledWith(9, 'Projects/2026/Plan.md')
    expect(mocks.previewProps).toMatchObject({
      content: 'Review ![[../../Media/diagram.png]]',
      interactive: false,
      resolveImageUrl,
      resolveFileLink,
      resolveWikiEmbed,
      resolveFileInfo,
      resolverRevision: 4,
    })
  })
})
