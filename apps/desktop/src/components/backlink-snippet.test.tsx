import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
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
