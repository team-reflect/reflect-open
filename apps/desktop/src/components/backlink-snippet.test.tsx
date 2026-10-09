import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnippetTask } from '@reflect/core'
import { BacklinkSnippet } from './backlink-snippet.tsx'

const writeTask = vi.hoisted(() => vi.fn())
vi.mock('@/lib/note-task.ts', () => ({ writeTask }))

const operationFail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations.ts', () => ({
  startOperation: () => ({ fail: operationFail }),
}))

vi.mock('@/providers/graph-provider.tsx', () => ({
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
    {
      locator: { astPath: [0, 1], markdown: 'prep agenda', checked: false },
      checked: false,
      text: 'prep agenda',
    },
    { locator: null, checked: true, text: 'square box' },
    {
      locator: { astPath: [0, 3], markdown: 'send invite', checked: true },
      checked: true,
      text: 'send invite',
    },
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
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  writeTask.mockReset()
  writeTask.mockResolvedValue(undefined)
  operationFail.mockReset()
})

describe('BacklinkSnippet task checkboxes', () => {
  it('writes a round-task click through to the source note', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    await userEvent.click(boxes[0]!)
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', astPath: [0, 1], markdown: 'prep agenda', checked: false },
      [{ kind: 'toggle' }],
      7,
    )
    await view.unmount()
  })

  it('toggles a checked round task by its own anchor', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[2]!)
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(
      { notePath: 'notes/meeting.md', astPath: [0, 3], markdown: 'send invite', checked: true },
      [{ kind: 'toggle' }],
      7,
    )
    await view.unmount()
  })

  it('leaves a square GFM checkbox read-only', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    await userEvent.click(boxes[1]!, { force: true })
    expect(writeTask).not.toHaveBeenCalled()
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
    expect(writeTask).not.toHaveBeenCalled()
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
        />
      </QueryClientProvider>,
    )
    expect(view.container.querySelector('[data-list-collapsed]')).toBeNull()
    expect(view.container.textContent).toContain('mention of')
    await view.unmount()
  })

  it('renders checkboxes inert when the snippet has no round tasks', async () => {
    const squareOnly: SnippetTask[] = [{ locator: null, checked: true, text: 'square box' }]
    const view = await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BacklinkSnippet
          text={'- [[Roadmap]] plan\n  - [x] square box'}
          notePath="notes/meeting.md"
          tasks={squareOnly}
          onWikilinkClick={() => {}}
        />
      </QueryClientProvider>,
    )
    const box = view.container.querySelector('input[type="checkbox"]')!
    await userEvent.click(box, { force: true })
    expect(writeTask).not.toHaveBeenCalled()
    await view.unmount()
  })
})

describe('BacklinkSnippet wiki-link chips', () => {
  it('labels chips through the host resolver and reports the full target', async () => {
    const onWikilinkClick = vi.fn()
    const view = await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BacklinkSnippet
          text={'- see [[Tim MacCaw // Dad|Dad]] and [[Tim MacCaw // Dad]]'}
          notePath="notes/meeting.md"
          tasks={[]}
          onWikilinkClick={onWikilinkClick}
        />
      </QueryClientProvider>,
    )
    const chips = view.getByTestId('wikilink')
    await expect.element(chips.first()).toMatchTextContent(/^Dad$/)
    await expect.element(chips.last()).toMatchTextContent(/^Tim MacCaw$/)
    await chips.first().click()
    expect(onWikilinkClick).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Tim MacCaw // Dad' }),
    )
    await view.unmount()
  })
})
