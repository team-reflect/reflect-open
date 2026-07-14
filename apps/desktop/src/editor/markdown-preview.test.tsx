import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from './markdown-preview'

interface CapturedMarkdownViewProps {
  readonly resolveImageUrl?: (src: string) => string | undefined
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
})
