import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnippetTask } from '@reflect/core'
import { BacklinkSnippet } from './backlink-snippet.tsx'

const toggleTask = vi.hoisted(() => vi.fn())
vi.mock('@/lib/tasks/task-store.ts', () => ({
  taskStore: () => ({
    current: (row: import('@reflect/core').Task) => row,
    update: (row: import('@reflect/core').Task) => {
      toggleTask({ notePath: row.notePath, astPath: row.astPath, checked: row.checked }, 7)
    },
  }),
}))

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
    { checked: false, round: true, text: 'prep agenda' },
    { checked: true, round: false, text: 'square box' },
    { checked: true, round: true, text: 'send invite' },
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
  toggleTask.mockReset()
  toggleTask.mockResolvedValue(undefined)
  operationFail.mockReset()
})

describe('BacklinkSnippet task checkboxes', () => {
  it('does not write checkboxes without an exact source address', async () => {
    const view = await renderSnippet()
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    for (const box of boxes) await userEvent.click(box, { force: true })
    expect(toggleTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('toggles only the addressed round checkbox at the rendered index', async () => {
    const tasks = anchors()
    tasks[2]!.address = { notePath: 'notes/meeting.md', astPath: [0, 3] }
    const view = await renderSnippet(tasks)
    const boxes = view.container.querySelectorAll('input[type="checkbox"]')
    await userEvent.click(boxes[2]!, { force: true })
    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith({ ...tasks[2]!.address, checked: true }, 7),
    )
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
    const squareOnly: SnippetTask[] = [{ checked: true, round: false, text: 'square box' }]
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
    expect(toggleTask).not.toHaveBeenCalled()
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
