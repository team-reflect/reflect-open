import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnippetTask } from '@reflect/core'
import { BacklinkSnippet } from './backlink-snippet'

const toggleTask = vi.hoisted(() => vi.fn())
vi.mock('@/lib/note-task', () => ({ toggleTask }))

const operationFail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations', () => ({
  startOperation: () => ({ fail: operationFail }),
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

const inertAttachmentProps = {
  onMarkdownLinkClick: () => false,
  resolveImageUrl: () => undefined,
  resolveFileLink: () => false,
  resolveWikiEmbed: () => undefined,
  resolveFileInfo: async () => undefined,
  openAttachment: async () => {},
  resolverRevision: 0,
}

/**
 * A context with one round task, one square box, and a nested round task —
 * the anchors mirror what `extractSnippetTasks` produces for this markdown
 * (exercised for real in `@reflect/core`'s tests; here they are fixtures so
 * the click wiring is what's under test).
 */
const SNIPPET = [
  '- [[Roadmap]] kickoff',
  '  + [ ] prep agenda',
  '  - [x] square box',
  '  + [x] send invite',
].join('\n')

function anchors(): SnippetTask[] {
  return [
    { markerOffset: 124, raw: '[ ] prep agenda', checked: false, round: true, text: 'prep agenda' },
    { markerOffset: 144, raw: '[x] square box', checked: true, round: false, text: 'square box' },
    { markerOffset: 164, raw: '[x] send invite', checked: true, round: true, text: 'send invite' },
  ]
}

function renderSnippet(tasks: SnippetTask[] = anchors()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BacklinkSnippet
        text={SNIPPET}
        notePath="notes/meeting.md"
        tasks={tasks}
        onWikilinkClick={() => {}}
        {...inertAttachmentProps}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  toggleTask.mockReset()
  toggleTask.mockResolvedValue(undefined)
  operationFail.mockReset()
})

describe('BacklinkSnippet task checkboxes', () => {
  it('writes a round-task click through to the source note', async () => {
    const view = renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    await userEvent.click(boxes[0]!)
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', markerOffset: 124, raw: '[ ] prep agenda' },
      7,
    )
    view.unmount()
  })

  it('toggles a checked round task by its own anchor', async () => {
    const view = renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[2]!)
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', markerOffset: 164, raw: '[x] send invite' },
      7,
    )
    view.unmount()
  })

  it('leaves a square GFM checkbox read-only', async () => {
    const view = renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    await userEvent.click(boxes[1]!)
    expect(toggleTask).not.toHaveBeenCalled()
    expect(operationFail).not.toHaveBeenCalled()
    view.unmount()
  })

  it('refuses instead of toggling when the anchors disagree with the rendered task', async () => {
    // Simulate anchor drift: the anchor for index 0 claims a different state.
    const drifted = anchors()
    drifted[0] = { ...drifted[0]!, checked: true }
    const view = renderSnippet(drifted)
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[0]!)
    expect(toggleTask).not.toHaveBeenCalled()
    await waitFor(() => expect(operationFail).toHaveBeenCalled())
    view.unmount()
  })

  it('renders checkboxes inert when the snippet has no round tasks', async () => {
    const squareOnly: SnippetTask[] = [
      { markerOffset: 144, raw: '[x] square box', checked: true, round: false, text: 'square box' },
    ]
    const view = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BacklinkSnippet
          text={'- [[Roadmap]] plan\n  - [x] square box'}
          notePath="notes/meeting.md"
          tasks={squareOnly}
          onWikilinkClick={() => {}}
          {...inertAttachmentProps}
        />
      </QueryClientProvider>,
    )
    const box = view.container.querySelector('input[type="checkbox"]')!
    await userEvent.click(box)
    expect(toggleTask).not.toHaveBeenCalled()
    view.unmount()
  })
})

describe('BacklinkSnippet attachments', () => {
  it('resolves nested-source Markdown and wiki attachments and opens file pills', async () => {
    const resolveImageUrl = vi.fn(
      (sourcePath: string, src: string) => `asset://${sourcePath}/${src}`,
    )
    const resolveFileLink = vi.fn(
      (_sourcePath: string, { href }: { href: string }) => href.endsWith('.pdf'),
    )
    const resolveWikiEmbed = vi.fn(
      (_sourcePath: string, { target }: { target: string }) =>
        target.endsWith('.png')
          ? { kind: 'image' as const, src: '/Media/wiki.png' }
          : { kind: 'file' as const, href: '/Media/wiki.pdf', name: 'Wiki PDF' },
    )
    const resolveFileInfo = vi.fn(async () => ({ size: 84 }))
    const openAttachment = vi.fn(async () => {})
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <BacklinkSnippet
          text={[
            '![](../../Media/standard.png)',
            '![[../../Media/wiki.png]]',
            '[Manual](../../Media/manual.pdf)',
            '![[../../Media/wiki.pdf]]',
          ].join('\n\n')}
          notePath="Projects/2026/Plan.md"
          tasks={[]}
          onWikilinkClick={() => {}}
          onMarkdownLinkClick={() => false}
          resolveImageUrl={resolveImageUrl}
          resolveFileLink={resolveFileLink}
          resolveWikiEmbed={resolveWikiEmbed}
          resolveFileInfo={resolveFileInfo}
          openAttachment={openAttachment}
          resolverRevision={3}
        />
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-testid="image-preview"] img')).toHaveLength(2)
      expect(view.getAllByTestId('file-pill')).toHaveLength(2)
    })
    expect(resolveImageUrl).toHaveBeenCalledWith(
      'Projects/2026/Plan.md',
      '../../Media/standard.png',
    )
    expect(resolveImageUrl).toHaveBeenCalledWith('Projects/2026/Plan.md', '/Media/wiki.png')
    expect(resolveFileLink).toHaveBeenCalledWith(
      'Projects/2026/Plan.md',
      expect.objectContaining({ href: '../../Media/manual.pdf' }),
    )
    expect(resolveWikiEmbed).toHaveBeenCalledWith(
      'Projects/2026/Plan.md',
      expect.objectContaining({ target: '../../Media/wiki.png' }),
    )
    expect(resolveFileInfo).toHaveBeenCalledWith(
      'Projects/2026/Plan.md',
      '../../Media/manual.pdf',
    )

    const pills = view.getAllByTestId('file-pill')
    await userEvent.click(pills[0]!)
    await userEvent.click(pills[1]!)
    expect(openAttachment).toHaveBeenNthCalledWith(
      1,
      'Projects/2026/Plan.md',
      '../../Media/manual.pdf',
    )
    expect(openAttachment).toHaveBeenNthCalledWith(
      2,
      'Projects/2026/Plan.md',
      '/Media/wiki.pdf',
    )
  })
})

describe('BacklinkSnippet note links', () => {
  it('preserves the source path for same-note wiki headings and relative Markdown links', async () => {
    const onWikilinkClick = vi.fn()
    const onMarkdownLinkClick = vi.fn(() => true)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <BacklinkSnippet
          text={'[[#Decisions]] and [Plan](../Plan.md#Scope)'}
          notePath="Projects/Meetings/Review.md"
          tasks={[]}
          onWikilinkClick={onWikilinkClick}
          onMarkdownLinkClick={onMarkdownLinkClick}
          resolveImageUrl={() => undefined}
          resolveFileLink={() => false}
          resolveWikiEmbed={() => undefined}
          resolveFileInfo={async () => undefined}
          openAttachment={async () => {}}
          resolverRevision={0}
        />
      </QueryClientProvider>,
    )

    await userEvent.click(view.getByTestId('wikilink'))
    const markdownLink = view.container.querySelector<HTMLAnchorElement>(
      'a[href="../Plan.md#Scope"]',
    )
    if (markdownLink === null) {
      throw new Error('expected the relative Markdown link to render')
    }
    await userEvent.click(markdownLink)

    expect(onWikilinkClick).toHaveBeenCalledWith(
      'Projects/Meetings/Review.md',
      expect.objectContaining({ target: '#Decisions' }),
    )
    expect(onMarkdownLinkClick).toHaveBeenCalledWith(
      'Projects/Meetings/Review.md',
      expect.objectContaining({ href: '../Plan.md#Scope' }),
    )
    view.unmount()
  })
})
