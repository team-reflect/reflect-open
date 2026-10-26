import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { BacklinkContext, BacklinkService } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { IncomingBacklinks } from './incoming-backlinks.tsx'

let core: TestCoreServices
let getBacklinksWithContext: MockInstance<BacklinkService['getBacklinksWithContext']>

/**
 * Answer the backlink read with `contexts` as its only page.
 */
function answerBacklinks(contexts: BacklinkContext[]): void {
  getBacklinksWithContext.mockResolvedValue({
    contexts,
    nextCursor: null,
    indexedLinkCount: contexts.length,
  })
}

function RouteProbe(): ReactNode {
  const { route, arrivalFocusEditor } = useRouter()
  return (
    <output data-testid="route" data-focus={String(arrivalFocusEditor)}>
      {JSON.stringify(route)}
    </output>
  )
}

/**
 * Render `ui` over the app of the running test, so a second render shares its session storage.
 */
function renderInGraph(ui: ReactNode) {
  return renderInApp(ui, { core, graph: { root: '/g', name: 'g', generation: 1 } })
}

function renderSection(path: string) {
  return renderInGraph(
    <>
      <IncomingBacklinks path={path} />
      <RouteProbe />
    </>,
  )
}

beforeEach(async () => {
  await page.viewport(375, 700)
  core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  getBacklinksWithContext = vi.spyOn(core.backlinks, 'getBacklinksWithContext')
})

describe('IncomingBacklinks', () => {
  it('renders nothing when the note has no inbound links (no empty chrome)', async () => {
    answerBacklinks([])
    const view = await renderSection('daily/2026-07-02.md')
    await vi.waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    await expect.element(view.getByText(/Incoming backlink/)).not.toBeInTheDocument()
    await view.unmount()
  })

  it('surfaces a failed query as an alert instead of rendering nothing', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('index unavailable'))
    const view = await renderSection('daily/2026-07-02.md')
    await expect.element(view.getByRole('alert')).toMatchTextContent('Couldn’t load backlinks.')
    await view.unmount()
  })

  it('groups references by source note under a counted header', async () => {
    answerBacklinks([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[2026-07-02]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'revisit on [[2026-07-02]]',
        posFrom: 80,
        tasks: [],
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship by [[2026-07-02]]',
        posFrom: 3,
        tasks: [],
      },
    ])
    const view = await renderSection('daily/2026-07-02.md')

    await expect.element(view.getByText('Incoming backlinks (3)')).toBeVisible()
    await expectLocatorToHaveCount(view.getByText('Meeting Notes'), 1)
    await expect.element(view.getByText(/discussed/)).toBeVisible()
    await expect.element(view.getByText(/revisit on/)).toBeVisible()
    await expect.element(view.getByText(/ship by/)).toBeVisible()
    await view.unmount()
  })

  it('navigates a daily-note source to the daily route (the carousel follows it)', async () => {
    answerBacklinks([
      {
        sourcePath: 'daily/2026-06-01.md',
        sourceTitle: 'June 1st, 2026',
        snippet: 'planned [[Roadmap]] here',
        posFrom: 4,
        tasks: [],
      },
    ])
    const view = await renderSection('notes/roadmap.md')

    await userEvent.click(view.getByText('June 1st, 2026'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"daily"')
    await expect.element(view.getByTestId('route')).toMatchTextContent('2026-06-01')
    // The daily surface stays mounted and swipes; no editor focus is raised.
    await expect.element(view.getByTestId('route')).toHaveAttribute('data-focus', 'false')
    await view.unmount()
  })

  it('navigates an ordinary source to the note route without a focus intent', async () => {
    answerBacklinks([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[2026-07-02]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = await renderSection('daily/2026-07-02.md')

    await userEvent.click(view.getByText('Meeting Notes'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/meeting.md')
    // A backlink tap must not request focus — that would raise the keyboard
    // through the mobile stack animation.
    await expect.element(view.getByTestId('route')).toHaveAttribute('data-focus', 'false')
    await view.unmount()
  })

  it('collapses snippets but keeps source titles on header toggle, for the session', async () => {
    answerBacklinks([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[2026-07-02]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = await renderSection('daily/2026-07-02.md')

    const header = view.getByRole('button', { name: /Incoming backlink \(1\)/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(view.getByText('Meeting Notes')).toBeVisible()
    await expect.element(view.getByText(/discussed/)).not.toBeInTheDocument()
    await view.unmount()

    const reopened = await renderSection('daily/2026-07-02.md')
    const persistedHeader = reopened.getByRole('button', {
      name: /Incoming backlink \(1\)/,
    })
    await expect.element(persistedHeader).toHaveAttribute('aria-expanded', 'false')
    await reopened.unmount()
  })

  it('shares the toggle with the desktop panel key across mounted sections', async () => {
    answerBacklinks([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = await renderInGraph(
      <>
        <IncomingBacklinks path="daily/2026-07-01.md" />
        <IncomingBacklinks path="daily/2026-07-02.md" />
      </>,
    )

    const headers = view.getByRole('button', { name: /Incoming backlink \(1\)/ })
    await expectLocatorToHaveCount(headers, 2)
    const [firstHeader, secondHeader] = headers.elements()

    await userEvent.click(firstHeader!)
    expect(firstHeader!.getAttribute('aria-expanded')).toBe('false')
    expect(secondHeader!.getAttribute('aria-expanded')).toBe('false')
    await view.unmount()
  })

  it('lets one group be peeked at via its always-visible chevron after a header collapse', async () => {
    answerBacklinks([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed follow-ups',
        posFrom: 12,
        tasks: [],
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the roadmap',
        posFrom: 3,
        tasks: [],
      },
    ])
    const view = await renderSection('daily/2026-07-02.md')

    const header = view.getByRole('button', { name: /Incoming backlinks \(2\)/ })
    await expect.element(header).toBeVisible()
    await userEvent.click(header)
    await expect.element(view.getByText(/discussed/)).not.toBeInTheDocument()
    await expect.element(view.getByText(/ship the/)).not.toBeInTheDocument()

    await userEvent.click(
      view.getByRole('button', { name: 'Expand references from Meeting Notes' }),
    )
    await expect.element(view.getByText(/discussed/)).toBeVisible()
    await expect.element(view.getByText(/ship the/)).not.toBeInTheDocument()

    await userEvent.click(header)
    await expect.element(view.getByText(/ship the/)).toBeVisible()
    await view.unmount()
  })
})
