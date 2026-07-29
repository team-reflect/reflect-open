import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WikilinkClickHandler } from '@meowdown/core'
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
  return renderSnippetText(SNIPPET, vi.fn(), tasks)
}

function renderSnippetText(
  text: string,
  onWikilinkClick: WikilinkClickHandler = vi.fn(),
  tasks: SnippetTask[] = [],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BacklinkSnippet
        text={text}
        notePath="notes/meeting.md"
        tasks={tasks}
        onWikilinkClick={onWikilinkClick}
        resolveImageUrl={() => undefined}
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
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    await userEvent.click(boxes[0]!)
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', markerOffset: 124, raw: '[ ] prep agenda' },
      7,
    )
    await view.unmount()
  })

  it('toggles a checked round task by its own anchor', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[2]!)
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', markerOffset: 164, raw: '[x] send invite' },
      7,
    )
    await view.unmount()
  })

  it('leaves a square GFM checkbox read-only', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    await userEvent.click(boxes[1]!, { force: true })
    expect(toggleTask).not.toHaveBeenCalled()
    expect(operationFail).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('refuses instead of toggling when the anchors disagree with the rendered task', async () => {
    // Simulate anchor drift: the anchor for index 0 claims a different state.
    const drifted = anchors()
    drifted[0] = { ...drifted[0]!, checked: true }
    const view = await renderSnippet(drifted)
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[0]!)
    expect(toggleTask).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(operationFail).toHaveBeenCalled())
    await view.unmount()
  })

  it('renders a collapsed source item expanded', async () => {
    // The parent is folded in the source note (`+` marker), so its line is
    // sliced into the context verbatim; the snippet must still show the
    // mention underneath instead of folding it away.
    const view = await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BacklinkSnippet
          text={'+ parent line\n  - mention of [[Roadmap]]'}
          notePath="notes/meeting.md"
          tasks={[]}
          onWikilinkClick={() => {}}
          resolveImageUrl={() => undefined}
        />
      </QueryClientProvider>,
    )
    expect(view.container.querySelector('[data-list-collapsed]')).toBeNull()
    expect(view.container.textContent).toContain('mention of')
    await view.unmount()
  })

  it('renders checkboxes inert when the snippet has no round tasks', async () => {
    const squareOnly: SnippetTask[] = [
      { markerOffset: 144, raw: '[x] square box', checked: true, round: false, text: 'square box' },
    ]
    const view = await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BacklinkSnippet
          text={'- [[Roadmap]] plan\n  - [x] square box'}
          notePath="notes/meeting.md"
          tasks={squareOnly}
          onWikilinkClick={() => {}}
          resolveImageUrl={() => undefined}
        />
      </QueryClientProvider>,
    )
    const box = view.container.querySelector('input[type="checkbox"]')!
    await userEvent.click(box, { force: true })
    expect(toggleTask).not.toHaveBeenCalled()
    await view.unmount()
  })
})

describe('BacklinkSnippet wiki-link rendering', () => {
  const regressionMatrix: Array<{ markdown: string; label: string; target: string }> = [
    {
      markdown: '[[Test: Colon Link]]',
      label: 'Test: Colon Link',
      target: 'Test: Colon Link',
    },
    {
      markdown: '[[Test Colon Link]]',
      label: 'Test Colon Link',
      target: 'Test Colon Link',
    },
    {
      markdown: '[[Test:Colon NoSpace Link]]',
      label: 'Test:Colon NoSpace Link',
      target: 'Test:Colon NoSpace Link',
    },
    {
      markdown: '[[Test 1:19 Digit Colon]]',
      label: 'Test 1:19 Digit Colon',
      target: 'Test 1:19 Digit Colon',
    },
    {
      markdown: '[[Test: Colon And Parens (2026-07-28)]]',
      label: 'Test: Colon And Parens (2026-07-28)',
      target: 'Test: Colon And Parens (2026-07-28)',
    },
    {
      markdown: '[[Test Long With Parens & Ampersand Follow-up (2026-07-28 1208) - Suffix Segment]]',
      label: 'Test Long With Parens & Ampersand Follow-up (2026-07-28 1208) - Suffix Segment',
      target: 'Test Long With Parens & Ampersand Follow-up (2026-07-28 1208) - Suffix Segment',
    },
    {
      markdown: '[[Meeting: VendorA x CompanyB AI Marketplace (2026-07-27)]]',
      label: 'Meeting: VendorA x CompanyB AI Marketplace (2026-07-27)',
      target: 'Meeting: VendorA x CompanyB AI Marketplace (2026-07-27)',
    },
    {
      markdown:
        '[[Meeting: AI Widget Builder Pricing Strategy & Partner Deal Follow-up (2026-07-28 1208) - CompanyB Forecast Meeting]]',
      label:
        'Meeting: AI Widget Builder Pricing Strategy & Partner Deal Follow-up (2026-07-28 1208) - CompanyB Forecast Meeting',
      target:
        'Meeting: AI Widget Builder Pricing Strategy & Partner Deal Follow-up (2026-07-28 1208) - CompanyB Forecast Meeting',
    },
  ]

  it.each(regressionMatrix)(
    'renders and clicks $markdown as a wiki link',
    async ({ markdown, label, target }) => {
      const onWikilinkClick = vi.fn<WikilinkClickHandler>()
      const view = await renderSnippetText(`See ${markdown}.`, onWikilinkClick)

      const chip = view.getByTestId('wikilink')
      await expect.element(chip).toHaveTextContent(label)
      await chip.click()

      await vi.waitFor(() => expect(onWikilinkClick).toHaveBeenCalledTimes(1))
      expect(onWikilinkClick.mock.calls[0]?.[0]).toMatchObject({ target })
      await view.unmount()
    },
  )

  const boundaryCases: Array<{ markdown: string; label: string; target: string }> = [
    { markdown: '[[Test:19]]', label: 'Test:19', target: 'Test:19' },
    { markdown: '[[19:Test]]', label: '19:Test', target: '19:Test' },
    { markdown: '[[Trailing:]]', label: 'Trailing:', target: 'Trailing:' },
    { markdown: '[[:Leading]]', label: ':Leading', target: ':Leading' },
    { markdown: '[[A:B:C]]', label: 'A:B:C', target: 'A:B:C' },
    { markdown: '[[James 1:19-20]]', label: 'James 1:19-20', target: 'James 1:19-20' },
    { markdown: '[[Target: Title|Alias: Display]]', label: 'Alias: Display', target: 'Target: Title' },
    {
      markdown:
        '[[This is a very long title: with a colon and enough words to cover wrapping without changing target extraction]]',
      label:
        'This is a very long title: with a colon and enough words to cover wrapping without changing target extraction',
      target:
        'This is a very long title: with a colon and enough words to cover wrapping without changing target extraction',
    },
    {
      markdown: '[[Partners: Pricing & Strategy (2026-07-28)]]',
      label: 'Partners: Pricing & Strategy (2026-07-28)',
      target: 'Partners: Pricing & Strategy (2026-07-28)',
    },
    {
      markdown: '[[Digest: follow-up — next steps]]',
      label: 'Digest: follow-up — next steps',
      target: 'Digest: follow-up — next steps',
    },
  ]

  it.each(boundaryCases)(
    'preserves boundary wiki-link target extraction for $markdown',
    async ({ markdown, label, target }) => {
      const onWikilinkClick = vi.fn<WikilinkClickHandler>()
      const view = await renderSnippetText(markdown, onWikilinkClick)

      const chip = view.getByTestId('wikilink')
      await expect.element(chip).toHaveTextContent(label)
      await chip.click()

      await vi.waitFor(() => expect(onWikilinkClick).toHaveBeenCalledTimes(1))
      expect(onWikilinkClick.mock.calls[0]?.[0]).toMatchObject({ target })
      await view.unmount()
    },
  )

  it('does not turn surrounding markdown syntax into wiki-link chips', async () => {
    const view = await renderSnippetText(
      [
        'Visit https://example.com/path:with-colon and [Docs: API](https://example.com/docs).',
        'Tag #project:alpha and time 1:19 are not wiki links.',
        '`[[Code: Literal]]`',
        '```',
        '[[Fence: Literal]]',
        '```',
        'But [[Actual: Link]] is.',
      ].join('\n'),
    )

    const chips = view.container.querySelectorAll('[data-testid="wikilink"]')
    expect(chips).toHaveLength(1)
    expect(chips[0]?.textContent).toBe('Actual: Link')
    await view.unmount()
  })
})
