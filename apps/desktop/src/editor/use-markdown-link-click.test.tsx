import type { MaybePromise } from '@reflect/utils'
import type { ReactNode } from 'react'
import { act } from '@/test-utils/act.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { LinkClickHandler } from '@meowdown/core'
import {
  createTestAppServices,
  createTestOpenerService,
  createTestWindowService,
  type TestOpenerService,
} from '@reflect/app/testing'
import {
  createTestCoreServices,
  createTestAttachmentService,
  createTestGraphSessionService,
  type TestAttachmentService,
} from '@reflect/core/testing'
import { useMarkdownLinkClick } from '@/editor/use-markdown-link-click.ts'
import { useRouter } from '@/routing/router.tsx'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'

const dispatchDeepLink = vi.fn<(url: string) => void>()
const resolveMarkdownHref = vi.fn()
// Receives the `reflect://` link of every note window a test opens.
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

const route = page.getByTestId('route')

let onLinkClick: LinkClickHandler

async function mount(sourcePath: string | null): Promise<void> {
  const graphSession = createTestGraphSessionService()
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    attachments,
    graphSession,
  })
  const linkNavigation = createTestAppServices(
    createTestCoreServices({
      database: createWasmTestDatabaseService(),
      graphSession,
      noteLinkResolver: { resolveWikiTarget: vi.fn(), resolveMarkdownHref },
      attachments,
    }),
    {
      window: createTestWindowService({ openNoteWindow }),
      opener,
      deepLinkRouter: Object.assign(
        createTestAppServices(createTestCoreServices({ database: createWasmTestDatabaseService() }))
          .deepLinkRouter,
        {
          dispatch: dispatchDeepLink,
        },
      ),
    },
  ).linkNavigation
  const { result } = await renderHookInApp(() => useMarkdownLinkClick(sourcePath), {
    core,
    appServices: { linkNavigation },
    graph: { generation: 7 },
    wrapper: (children) => (
      <>
        {children}
        <RouteProbe />
      </>
    ),
  })
  onLinkClick = result.current
}

async function click(href: string, metaKey = false): Promise<MouseEvent> {
  const event = new MouseEvent('click', { cancelable: true, metaKey })
  await act(() => onLinkClick({ href, event, mod: metaKey }))
  return event
}

let opener: TestOpenerService
let attachments: TestAttachmentService

beforeEach(async () => {
  vi.clearAllMocks()
  opener = createTestOpenerService()
  attachments = createTestAttachmentService()
  openNoteWindow.mockResolvedValue(true)
  resolveMarkdownHref.mockResolvedValue({ kind: 'missing' })
  await mount('projects/TASKS.md')
})

describe('useMarkdownLinkClick', () => {
  it('opens an http(s) link in the OS browser and blocks the frame navigation', async () => {
    const event = await click('https://example.com')

    expect(opener.openedUrls()).toEqual(['https://example.com'])
    expect(event.defaultPrevented).toBe(true)
  })

  it('routes a reflect:// link through the in-app deep-link intake, not the URL opener', async () => {
    await click('reflect://note/abc123')

    expect(dispatchDeepLink).toHaveBeenCalledWith('reflect://note/abc123')
    expect(opener.openedUrls()).toEqual([])
  })

  it('⌘-clicks a rendered reflect:// link into a secondary window', async () => {
    await click('reflect://note/abc123', true)

    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledWith('reflect://note/abc123'))
    expect(dispatchDeepLink).not.toHaveBeenCalled()
  })

  it('opens a custom app scheme in its OS default app', async () => {
    const event = await click('x-devonthink-item://40C88434-68B6-4DCB-A258-754679764C3C')

    expect(opener.openedUrls()).toEqual([
      'x-devonthink-item://40C88434-68B6-4DCB-A258-754679764C3C',
    ])
    expect(event.defaultPrevented).toBe(true)
  })

  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['blob:https://example.com/uuid'],
  ])('drops the unsafe scheme %s without opening anything', async (href) => {
    const event = await click(href)

    expect(opener.openedUrls()).toEqual([])
    expect(dispatchDeepLink).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens a relative note link from the source note', async () => {
    resolveMarkdownHref.mockResolvedValue({
      kind: 'resolved',
      path: 'projects/roadmap/plan.md',
    })
    const event = await click('./roadmap/plan.md')

    expect(resolveMarkdownHref).toHaveBeenCalledWith('projects/TASKS.md', './roadmap/plan.md', 7)
    await expect
      .element(route)
      .toMatchTextContent('{"kind":"note","path":"projects/roadmap/plan.md"}')
    expect(opener.openedUrls()).toEqual([])
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens an attachment link through the graph asset opener, not the URL opener', async () => {
    await click('assets/cat.png')

    await vi.waitFor(() => expect(attachments.opened()).toEqual(['assets/cat.png']))
    expect(opener.openedUrls()).toEqual([])
    expect(resolveMarkdownHref).not.toHaveBeenCalled()
  })

  it('drops attachment and note links when the Markdown belongs to no note', async () => {
    await mount(null)

    const asset = await click('assets/cat.png')
    const note = await click('notes/foo.md')

    expect(attachments.opened()).toEqual([])
    expect(resolveMarkdownHref).not.toHaveBeenCalled()
    expect(opener.openedUrls()).toEqual([])
    expect(dispatchDeepLink).not.toHaveBeenCalled()
    expect(asset.defaultPrevented).toBe(true)
    expect(note.defaultPrevented).toBe(true)
  })
})
