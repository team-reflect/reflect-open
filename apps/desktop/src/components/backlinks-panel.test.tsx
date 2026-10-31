import type { MaybePromise } from '@reflect/utils'
import { createTestWindowService } from '@reflect/app/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BacklinkContext,
  BacklinkContextPage,
  BacklinkService,
  NoteCreationService,
  NoteLinkResolverService,
} from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { BacklinksPanel } from './backlinks-panel.tsx'
import { deepLinkForRoute } from '@reflect/app'

// What the app's fakes answer; each test sets them before `renderPanel`.
const getBacklinksWithContext = vi.fn<BacklinkService['getBacklinksWithContext']>()
const resolveOrCreateNoteWithTitle = vi.fn<NoteCreationService['resolveOrCreateNoteWithTitle']>()
const resolveMarkdownHref = vi.fn<NoteLinkResolverService['resolveMarkdownHref']>()
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()

function wrapBacklinkContexts(contexts: BacklinkContext[]): BacklinkContextPage {
  return { contexts, nextCursor: null, indexedLinkCount: contexts.length }
}

function createCore() {
  const services = createTestCoreServices({ database: createWasmTestDatabaseService() })
  vi.spyOn(services.backlinks, 'getBacklinksWithContext').mockImplementation(
    getBacklinksWithContext,
  )
  vi.spyOn(services.noteCreation, 'resolveOrCreateNoteWithTitle').mockImplementation(
    resolveOrCreateNoteWithTitle,
  )
  vi.spyOn(services.noteLinkResolver, 'resolveMarkdownHref').mockImplementation(resolveMarkdownHref)
  return services
}

// One app per test, so a panel rendered twice shares its session storage.
let core: ReturnType<typeof createCore>

function RouteProbe(): ReactNode {
  const { route, arrivalFocusEditor } = useRouter()
  return (
    <output data-testid="route" data-focus={String(arrivalFocusEditor)}>
      {JSON.stringify(route)}
    </output>
  )
}

function renderInGraph(ui: ReactNode) {
  return renderInApp(ui, {
    core,
    appServices: { window: createTestWindowService({ openNoteWindow }) },
    graph: { root: '/g', name: 'g', generation: 1 },
  })
}

function renderPanel(path: string) {
  return renderInGraph(
    <>
      <BacklinksPanel path={path} />
      <RouteProbe />
    </>,
  )
}

beforeEach(() => {
  getBacklinksWithContext.mockReset()
  resolveOrCreateNoteWithTitle.mockReset()
  resolveMarkdownHref.mockReset()
  openNoteWindow.mockReset().mockResolvedValue(true)
  core = createCore()
})

describe('BacklinksPanel', () => {
  it('renders nothing when the note has no inbound links', async () => {
    getBacklinksWithContext.mockResolvedValue(wrapBacklinkContexts([]))
    const view = await renderPanel('notes/lonely.md')
    await vi.waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    expect(view.getByText(/Incoming backlink/).query()).toBeNull()
    await view.unmount()
  })

  it('surfaces a failed query as an alert instead of rendering nothing', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('index unavailable'))
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByRole('alert')).toMatchTextContent('Couldn’t load backlinks.')
    await view.unmount()
  })

  it('uses the singular header for one inbound link', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
      ]),
    )
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByText('Incoming backlink (1)')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders a snippet wiki link as a clickable chip that navigates to its target', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
      ]),
    )
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/roadmap.md',
    })
    const view = await renderPanel('notes/source.md')

    // The [[Roadmap]] source renders as a chip whose label is the bare target,
    // not the raw bracket syntax.
    const chip = view.getByTestId('wikilink')
    await expect.element(chip).toMatchTextContent(/^Roadmap$/)

    await chip.click()
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/roadmap.md')
    await view.unmount()
  })

  it('names a daily-note source and a date chip by their day, not the ISO date', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'daily/2026-06-09.md',
          sourceTitle: '2026-06-09',
          snippet: 'moved from [[2026-06-08]]',
          posFrom: 12,
          tasks: [],
        },
      ]),
    )
    const view = await renderPanel('notes/roadmap.md')

    await expect
      .element(view.getByRole('button', { name: 'Tue, June 9th, 2026', exact: true }))
      .toBeInTheDocument()
    await expect.element(view.getByTestId('wikilink')).toMatchTextContent(/^Mon, June 8th, 2026$/)
    await view.unmount()
  })

  it('opens a relative Markdown link in a snippet from its source note', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'projects/TASKS.md',
          sourceTitle: 'Project Tasks',
          snippet: '- [[Roadmap]]\n  - [plan](./roadmap/plan.md)',
          posFrom: 0,
          tasks: [],
        },
      ]),
    )
    resolveMarkdownHref.mockResolvedValue({
      kind: 'resolved',
      path: 'projects/roadmap/plan.md',
    })
    const view = await renderPanel('notes/roadmap.md')

    await view.getByRole('link', { name: 'plan' }).click()

    await vi.waitFor(() => {
      expect(resolveMarkdownHref).toHaveBeenCalledWith('projects/TASKS.md', './roadmap/plan.md', 1)
    })
    await expect
      .element(view.getByTestId('route'))
      .toMatchTextContent('{"kind":"note","path":"projects/roadmap/plan.md"}')
    await view.unmount()
  })

  it('groups references by source note and navigates on title click', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'revisit [[Roadmap]] next week',
          posFrom: 80,
          tasks: [],
        },
        {
          sourcePath: 'notes/planning.md',
          sourceTitle: 'Planning',
          snippet: 'ship the [[Roadmap]]',
          posFrom: 3,
          tasks: [],
        },
      ]),
    )
    const view = await renderPanel('notes/roadmap.md')

    await expect.element(view.getByText('Incoming backlinks (3)')).toBeInTheDocument()
    await expectLocatorToHaveCount(view.getByText('Meeting Notes'), 1)
    // Snippets render as rich text: the leading prose survives, the [[…]] source
    // becomes a chip whose label shows the bare target.
    await expect.element(view.getByText(/discussed/)).toBeInTheDocument()
    await expect.element(view.getByText(/revisit/)).toBeInTheDocument()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
    await expectLocatorToHaveCount(view.getByTestId('wikilink'), 3)

    await view.getByText('Meeting Notes').click()
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/meeting.md')
    // A backlink tap must not request focus — on mobile that would raise the
    // keyboard mid-arrival; desktop autofocuses note arrivals on its own.
    await expect.element(view.getByTestId('route')).toHaveAttribute('data-focus', 'false')
    await view.unmount()
  })

  it('opens a ⌘-clicked backlink source in a new window', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
      ]),
    )
    const view = await renderPanel('notes/roadmap.md')

    await view.getByText('Meeting Notes').click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() => {
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({
          kind: 'note',
          path: 'notes/meeting.md',
        }),
      )
    })
    await expect.element(view.getByTestId('route')).toMatchTextContent('"today"')
    await view.unmount()
  })

  it('collapses snippets but keeps source titles on header toggle, for the session', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
      ]),
    )
    const view = await renderPanel('notes/roadmap.md')

    const header = view.getByRole('button', { name: /Incoming backlink \(1\)/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')

    await header.click()
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(view.getByText('Meeting Notes')).toBeInTheDocument()
    expect(view.getByText(/discussed/).query()).toBeNull()
    await view.unmount()

    const reopened = await renderPanel('notes/roadmap.md')
    const persistedHeader = reopened.getByRole('button', {
      name: /Incoming backlink \(1\)/,
    })
    await expect.element(persistedHeader).toHaveAttribute('aria-expanded', 'false')
    await reopened.unmount()
  })

  it('resets a collapsed group when navigating to another note with the same source', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/shared.md',
          sourceTitle: 'Shared Source',
          snippet: 'links [[A]] and [[B]]',
          posFrom: 5,
          tasks: [],
        },
      ]),
    )
    const view = await renderInGraph(<BacklinksPanel path="notes/a.md" />)

    await expect.element(view.getByText(/links/)).toBeInTheDocument()
    await view.getByRole('button', { name: 'Collapse references from Shared Source' }).click()
    expect(view.getByText(/links/).query()).toBeNull()

    await view.rerender(<BacklinksPanel path="notes/b.md" />)
    await expect.element(view.getByText(/links/)).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps simultaneously mounted panels in sync (one per day in the stream)', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
      ]),
    )
    const view = await renderInGraph(
      <>
        <BacklinksPanel path="daily/2026-06-09.md" />
        <BacklinksPanel path="daily/2026-06-10.md" />
      </>,
    )

    const headers = view.getByRole('button', { name: /Incoming backlink \(1\)/ })
    await expectLocatorToHaveCount(headers, 2)

    await headers.nth(0).click()
    await expect.element(headers.nth(0)).toHaveAttribute('aria-expanded', 'false')
    await expect.element(headers.nth(1)).toHaveAttribute('aria-expanded', 'false')
    expect(view.getByText(/discussed/).query()).toBeNull()
    await view.unmount()
  })

  it('lets one group be peeked at after the header collapse (old Reflect behavior)', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
        {
          sourcePath: 'notes/planning.md',
          sourceTitle: 'Planning',
          snippet: 'ship the [[Roadmap]]',
          posFrom: 3,
          tasks: [],
        },
      ]),
    )
    const view = await renderPanel('notes/roadmap.md')

    const header = view.getByRole('button', { name: /Incoming backlinks \(2\)/ })
    await header.click()
    expect(view.getByText(/discussed/).query()).toBeNull()
    expect(view.getByText(/ship the/).query()).toBeNull()

    await view.getByRole('button', { name: 'Expand references from Meeting Notes' }).click()
    await expect.element(view.getByText(/discussed/)).toBeInTheDocument()
    expect(view.getByText(/ship the/).query()).toBeNull()

    await header.click()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
    await view.unmount()
  })

  it('collapses one source group via its own chevron', async () => {
    getBacklinksWithContext.mockResolvedValue(
      wrapBacklinkContexts([
        {
          sourcePath: 'notes/meeting.md',
          sourceTitle: 'Meeting Notes',
          snippet: 'discussed [[Roadmap]] follow-ups',
          posFrom: 12,
          tasks: [],
        },
        {
          sourcePath: 'notes/planning.md',
          sourceTitle: 'Planning',
          snippet: 'ship the [[Roadmap]]',
          posFrom: 3,
          tasks: [],
        },
      ]),
    )
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByText('Incoming backlinks (2)')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Collapse references from Meeting Notes' }).click()
    expect(view.getByText(/discussed/).query()).toBeNull()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
    await view.unmount()
  })
})
