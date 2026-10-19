import type { MaybePromise } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import {
  type NoteCreationService,
  type NoteLinkResolverService,
  createWikiResolverService,
  type WikiResolverService,
} from '@reflect/core'
import {
  createTestAttachmentService,
  createNodeTestDatabaseService,
  createTestGraphSessionService,
  createTestLoggerService,
  createTestNoteCreationService,
  createTestNoteFileService,
  createTestNoteLinkResolverService,
  createTestPlatformService,
  type TestOpenGraph,
  type TestPlatformOptions,
  createTestDeepLinkIntakeService,
} from '@reflect/core/testing'
import { createTestOpenerService } from '../testing/opener.ts'
import { createTestWindowService } from '../testing/window.ts'
import { createTestOperationsService } from '../testing/operations.ts'
import { createTestNavigationService } from '../testing/navigation.ts'
import { createDeepLinkRouter } from './deep-link-router.ts'
import {
  createLinkNavigationService,
  isOpenableExternalUrl,
  routeForTag,
  type LinkNavigationHost,
  type LinkNavigationService,
} from './link-navigation-service.ts'
import type { Route } from './route.ts'

function AMBIGUOUS_MESSAGE(title: string): string {
  return `Couldn’t safely choose one note matching “${title}”. Rename conflicting notes or wait for unavailable notes to become available, then try again.`
}

function UNAVAILABLE_MESSAGE(name: string): string {
  return `Couldn’t open “${name}” because a matching note is currently unavailable. Try again when it is available on this device.`
}

function setup(options?: {
  files?: Readonly<Record<string, string>>
  evicted?: readonly string[]
  platform?: TestPlatformOptions
  openNoteWindow?: (deepLink: string) => MaybePromise<boolean>
  noteLinkResolver?: NoteLinkResolverService
  resolveOrCreateNoteWithTitle?: NoteCreationService['resolveOrCreateNoteWithTitle']
  resolveWikiTarget?: WikiResolverService['resolveWikiTarget']
  graph?: TestOpenGraph | null
}) {
  const noteFile = createTestNoteFileService({
    files: options?.files ?? {},
    evicted: options?.evicted ?? [],
  })
  const noteLinkResolver = createTestNoteLinkResolverService({ noteFile })
  const noteCreation = createTestNoteCreationService({ noteFile, noteLinkResolver })
  const window = createTestWindowService(
    options?.openNoteWindow === undefined ? {} : { openNoteWindow: options.openNoteWindow },
  )
  const opener = createTestOpenerService()
  const deepLinkIntake = createTestDeepLinkIntakeService()
  const attachments = createTestAttachmentService()
  const operations = createTestOperationsService()
  const logger = createTestLoggerService()
  const navigation = createTestNavigationService()
  const graphSession = createTestGraphSessionService({
    graph: options?.graph === undefined ? { generation: 7 } : options.graph,
  })
  if (options?.resolveOrCreateNoteWithTitle !== undefined) {
    vi.spyOn(noteCreation, 'resolveOrCreateNoteWithTitle').mockImplementation(
      options.resolveOrCreateNoteWithTitle,
    )
  }
  const wikiResolver = createWikiResolverService({ database: createNodeTestDatabaseService() })
  if (options?.resolveWikiTarget !== undefined) {
    vi.spyOn(wikiResolver, 'resolveWikiTarget').mockImplementation(options.resolveWikiTarget)
  }
  const linkNavigation = createLinkNavigationService({
    noteLinkResolver: options?.noteLinkResolver ?? noteLinkResolver,
    noteCreation,
    wikiResolver,
    window,
    platform: createTestPlatformService(options?.platform),
    opener,
    deepLinkRouter: createDeepLinkRouter({ intake: deepLinkIntake, logger, graphSession }),
    navigation,
    attachments,
    operations,
    logger,
    graphSession,
  })
  return {
    linkNavigation,
    host: createHost(linkNavigation),
    navigation,
    noteFile,
    noteLinkResolver,
    noteCreation,
    window,
    opener,
    deepLinkIntake,
    attachments,
    operations,
    logger,
  }
}

/**
 * A link host whose activations go stale as the service's probe says, or on `leave()`.
 */
function createHost(linkNavigation: LinkNavigationService): LinkNavigationHost & {
  routes: () => readonly Route[]
  leave: () => void
} {
  const routes: Route[] = []
  let left = false
  return {
    navigate: (route) => {
      routes.push(route)
    },
    beginIntent: () => {
      const isStale = linkNavigation.beginIntent()
      return () => left || isStale()
    },
    routes: () => [...routes],
    leave: () => {
      left = true
    },
  }
}

/**
 * Lets settled promises of the in-memory doubles run their continuations.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('intent token', () => {
  it('keeps only the newest intent current', () => {
    const { linkNavigation } = setup()
    const older = linkNavigation.beginIntent()
    expect(older()).toBe(false)
    const newer = linkNavigation.beginIntent()
    expect(older()).toBe(true)
    expect(newer()).toBe(false)
  })

  it('is separate for each service', () => {
    const first = setup().linkNavigation
    const second = setup().linkNavigation
    const isStale = first.beginIntent()
    second.beginIntent()
    second.beginIntent()
    expect(isStale()).toBe(false)
  })

  it('goes stale once the navigation revision advances', () => {
    const { linkNavigation, navigation } = setup()
    const isStale = linkNavigation.beginIntent()
    navigation.navigate({ kind: 'tasks' })
    expect(isStale()).toBe(true)
    expect(linkNavigation.beginIntent()()).toBe(false)
  })
})

describe('openRouteInNewWindow', () => {
  it('opens the route’s deep link', async () => {
    const { linkNavigation, window } = setup()
    await expect(
      linkNavigation.openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' }),
    ).resolves.toBe(true)
    expect(window.openedNoteWindows()).toEqual(['reflect://note/notes%2Ffoo.md'])
  })

  it('declines routes the deep-link grammar does not name', async () => {
    const { linkNavigation, window } = setup()
    await expect(
      linkNavigation.openRouteInNewWindow({ kind: 'allNotes', tag: null }),
    ).resolves.toBe(false)
    expect(window.openedNoteWindows()).toEqual([])
  })

  it('declines without a native shell and on mobile', async () => {
    const browser = setup({ platform: { isNativeShell: false } })
    await expect(
      browser.linkNavigation.openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' }),
    ).resolves.toBe(false)
    const mobile = setup({ platform: { surface: { mobileApp: true } } })
    await expect(
      mobile.linkNavigation.openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' }),
    ).resolves.toBe(false)
    expect(browser.window.openedNoteWindows()).toEqual([])
    expect(mobile.window.openedNoteWindows()).toEqual([])
  })

  it('answers false when the window does not open', async () => {
    const { linkNavigation } = setup({ openNoteWindow: () => false })
    await expect(
      linkNavigation.openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' }),
    ).resolves.toBe(false)
  })
})

describe('openDeepLinkInNewWindow', () => {
  it('opens addressing links verbatim', async () => {
    const { linkNavigation, window } = setup()
    await expect(
      linkNavigation.openDeepLinkInNewWindow('reflect://note/Some%20Note'),
    ).resolves.toBe(true)
    expect(window.openedNoteWindows()).toEqual(['reflect://note/Some%20Note'])
  })

  it('declines capture links — they are writes, not places', async () => {
    const { linkNavigation, window } = setup()
    await expect(linkNavigation.openDeepLinkInNewWindow('reflect://append?text=hi')).resolves.toBe(
      false,
    )
    expect(window.openedNoteWindows()).toEqual([])
  })

  it('declines malformed links', async () => {
    const { linkNavigation, window } = setup()
    await expect(linkNavigation.openDeepLinkInNewWindow('reflect://nonsense/x')).resolves.toBe(
      false,
    )
    expect(window.openedNoteWindows()).toEqual([])
  })

  it('declines without a native shell and on mobile', async () => {
    const browser = setup({ platform: { isNativeShell: false } })
    await expect(browser.linkNavigation.openDeepLinkInNewWindow('reflect://note/x')).resolves.toBe(
      false,
    )
    const mobile = setup({ platform: { surface: { mobileApp: true } } })
    await expect(mobile.linkNavigation.openDeepLinkInNewWindow('reflect://note/x')).resolves.toBe(
      false,
    )
  })
})

describe('openNoteLink', () => {
  const alpha: Route = { kind: 'note', path: 'notes/alpha.md' }
  const bravo: Route = { kind: 'note', path: 'notes/bravo.md' }

  it('navigates a plain activation in the current window', () => {
    const { linkNavigation, host, window } = setup()
    linkNavigation.openNoteLink({ target: alpha, openInNewWindow: false }, host)
    expect(host.routes()).toEqual([alpha])
    expect(window.openedNoteWindows()).toEqual([])
  })

  it('opens a new-window request in a secondary window without navigating', async () => {
    const { linkNavigation, host, window } = setup()
    linkNavigation.openNoteLink({ target: alpha, openInNewWindow: true }, host)
    await settle()
    expect(window.openedNoteWindows()).toEqual(['reflect://note/notes%2Falpha.md'])
    expect(host.routes()).toEqual([])
  })

  it('falls back to current-window navigation when a secondary window is declined', async () => {
    const { linkNavigation, host } = setup({ openNoteWindow: () => false })
    linkNavigation.openNoteLink({ target: alpha, openInNewWindow: true }, host)
    await settle()
    expect(host.routes()).toEqual([alpha])
  })

  it('falls back to current-window navigation when a secondary window open rejects', async () => {
    const { linkNavigation, host } = setup({
      openNoteWindow: () => Promise.reject(new Error('window creation failed')),
    })
    linkNavigation.openNoteLink({ target: alpha, openInNewWindow: true }, host)
    await settle()
    expect(host.routes()).toEqual([alpha])
  })

  it('does not let an older failed open override a newer note-link intent', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    const { linkNavigation, host } = setup({ openNoteWindow: () => pendingOpen.promise })
    linkNavigation.openNoteLink({ target: alpha, openInNewWindow: true }, host)
    linkNavigation.openNoteLink({ target: bravo, openInNewWindow: false }, host)
    pendingOpen.resolve(false)
    await settle()
    expect(host.routes()).toEqual([bravo])
  })

  it('does not let an older rejected open override a newer note-link intent', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    let opens = 0
    const { linkNavigation, host } = setup({
      openNoteWindow: () => {
        opens += 1
        return opens === 1 ? pendingOpen.promise : true
      },
    })
    linkNavigation.openNoteLink({ target: alpha, openInNewWindow: true }, host)
    linkNavigation.openNoteLink({ target: bravo, openInNewWindow: true }, host)
    pendingOpen.reject(new Error('window creation failed'))
    await settle()
    expect(host.routes()).toEqual([])
  })

  it('does not fall back after the host goes stale', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    const { linkNavigation, host } = setup({ openNoteWindow: () => pendingOpen.promise })
    linkNavigation.openNoteLink({ target: alpha, openInNewWindow: true }, host)
    host.leave()
    pendingOpen.resolve(false)
    await settle()
    expect(host.routes()).toEqual([])
  })
})

describe('followWikiLink', () => {
  it('navigates to the resolved note without creating', async () => {
    const { linkNavigation, host, noteCreation } = setup({
      files: { 'notes/target.md': '# Target' },
    })
    linkNavigation.followWikiLink({ target: 'Target', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'notes/target.md' }])
    expect(noteCreation.created()).toEqual([])
  })

  it('treats an unresolved ISO date as a daily target', async () => {
    const { linkNavigation, host, noteCreation, noteLinkResolver } = setup()
    linkNavigation.followWikiLink({ target: '2026-06-09', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([{ kind: 'daily', date: '2026-06-09' }])
    expect(noteCreation.created()).toEqual([])
    expect(noteLinkResolver.calls()).toMatchObject([
      { kind: 'wiki', target: '2026-06-09', generation: 7, result: { kind: 'missing' } },
    ])
  })

  it('preserves an existing regular note titled as an ISO date', async () => {
    const { linkNavigation, host } = setup({ files: { 'notes/2026-06-09.md': '# 2026-06-09' } })
    linkNavigation.followWikiLink({ target: '2026-06-09', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'notes/2026-06-09.md' }])
  })

  it('retains read-only index resolution for ISO dates with no graph open', async () => {
    const targets: string[] = []
    const { linkNavigation, host, noteLinkResolver } = setup({
      graph: null,
      resolveWikiTarget: (target) => {
        targets.push(target)
        return Promise.resolve({ kind: 'resolved', ref: 'notes/2026-06-09.md' })
      },
    })
    linkNavigation.followWikiLink({ target: '2026-06-09', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'notes/2026-06-09.md' }])
    expect(targets).toEqual(['2026-06-09'])
    expect(noteLinkResolver.calls()).toEqual([])
  })

  it('opens the lazy daily route for an unindexed ISO date when read-only', async () => {
    const { linkNavigation, host } = setup({
      resolveWikiTarget: (target) => Promise.resolve({ kind: 'unresolved', text: target }),
    })
    linkNavigation.followWikiLink(
      { target: '2026-06-09', openInNewWindow: false, readOnly: true },
      host,
    )
    await settle()
    expect(host.routes()).toEqual([{ kind: 'daily', date: '2026-06-09' }])
  })

  it('does not choose between ambiguous ISO-date targets', async () => {
    const { linkNavigation, host, noteCreation, operations } = setup({
      noteLinkResolver: {
        resolveWikiTarget: () => ({
          kind: 'ambiguous',
          paths: ['daily/2026-06-09.md', 'daily/2026-06-09-2.md'],
        }),
        resolveMarkdownHref: () => ({ kind: 'missing' }),
      },
    })
    linkNavigation.followWikiLink({ target: '2026-06-09', openInNewWindow: false }, host)
    await settle()
    expect(operations.findByLabel('Opening link')).toMatchObject({
      status: 'failed',
      message: AMBIGUOUS_MESSAGE('2026-06-09'),
    })
    expect(host.routes()).toEqual([])
    expect(noteCreation.created()).toEqual([])
  })

  it('does not turn an unavailable ISO-date target into a lazy daily route', async () => {
    const { linkNavigation, host, operations } = setup({
      noteLinkResolver: {
        resolveWikiTarget: () => ({ kind: 'unavailable', paths: ['daily/2026-06-09.md'] }),
        resolveMarkdownHref: () => ({ kind: 'missing' }),
      },
    })
    linkNavigation.followWikiLink({ target: '2026-06-09', openInNewWindow: false }, host)
    await settle()
    expect(operations.findByLabel('Opening link')).toMatchObject({
      status: 'failed',
      message: UNAVAILABLE_MESSAGE('2026-06-09'),
    })
    expect(host.routes()).toEqual([])
  })

  it('routes a resolved daily alias through the daily view', async () => {
    const { linkNavigation, host } = setup({
      resolveOrCreateNoteWithTitle: () =>
        Promise.resolve({
          kind: 'resolved',
          path: 'daily/2026-06-09.md',
        }),
    })
    linkNavigation.followWikiLink({ target: 'Project log', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([{ kind: 'daily', date: '2026-06-09' }])
  })

  it('creates and opens an unresolved title', async () => {
    const { linkNavigation, host, noteCreation, noteFile } = setup()
    linkNavigation.followWikiLink({ target: 'Brand New', openInNewWindow: false }, host)
    await settle()
    expect(noteCreation.created()).toEqual(['notes/brand-new.md'])
    expect(noteFile.writes()).toMatchObject([{ path: 'notes/brand-new.md' }])
    expect(host.routes()).toEqual([{ kind: 'note', path: 'notes/brand-new.md' }])
  })

  it('does not create when read-only', async () => {
    const { linkNavigation, host, noteCreation } = setup({
      resolveWikiTarget: (target) => Promise.resolve({ kind: 'unresolved', text: target }),
    })
    linkNavigation.followWikiLink(
      { target: 'Brand New', openInNewWindow: false, readOnly: true },
      host,
    )
    await settle()
    expect(noteCreation.created()).toEqual([])
    expect(host.routes()).toEqual([])
  })

  it('opens an indexed title with no graph open', async () => {
    const { linkNavigation, host } = setup({
      graph: null,
      resolveWikiTarget: () => Promise.resolve({ kind: 'resolved', ref: 'notes/target.md' }),
    })
    linkNavigation.followWikiLink({ target: 'Target', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'notes/target.md' }])
  })

  it('ignores an empty target', async () => {
    const { linkNavigation, host, noteLinkResolver, noteCreation } = setup()
    linkNavigation.followWikiLink({ target: '   ', openInNewWindow: false }, host)
    await settle()
    expect(noteLinkResolver.calls()).toEqual([])
    expect(noteCreation.created()).toEqual([])
    expect(host.routes()).toEqual([])
  })

  it('opens the resolved note in a new window instead of navigating', async () => {
    const { linkNavigation, host, window } = setup({ files: { 'notes/target.md': '# Target' } })
    linkNavigation.followWikiLink({ target: 'Target', openInNewWindow: true }, host)
    await settle()
    expect(window.openedNoteWindows()).toEqual(['reflect://note/notes%2Ftarget.md'])
    expect(host.routes()).toEqual([])
  })

  it('still creates an unresolved title, then opens the new window', async () => {
    const { linkNavigation, host, window, noteCreation } = setup()
    linkNavigation.followWikiLink({ target: 'Brand New', openInNewWindow: true }, host)
    await settle()
    expect(noteCreation.created()).toEqual(['notes/brand-new.md'])
    expect(window.openedNoteWindows()).toEqual(['reflect://note/notes%2Fbrand-new.md'])
    expect(host.routes()).toEqual([])
  })

  it('falls back to in-window navigation when the new window is declined', async () => {
    const { linkNavigation, host } = setup({
      files: { 'notes/target.md': '# Target' },
      openNoteWindow: () => false,
    })
    linkNavigation.followWikiLink({ target: 'Target', openInNewWindow: true }, host)
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'notes/target.md' }])
  })

  it('does not navigate when title resolution is ambiguous', async () => {
    const { linkNavigation, host, operations, noteCreation } = setup({
      files: {
        'notes/business-ideas.md': '# Business ideas',
        'notes/business-ideas-2.md': '# Business ideas',
      },
    })
    linkNavigation.followWikiLink({ target: 'Business ideas', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([])
    expect(noteCreation.created()).toEqual([])
    expect(operations.findByLabel('Opening link')).toMatchObject({
      status: 'failed',
      message: AMBIGUOUS_MESSAGE('Business ideas'),
    })
  })

  it('does not navigate or create when a matching title is unavailable', async () => {
    const { linkNavigation, host, operations, noteCreation } = setup({
      files: { 'notes/business-ideas.md': '# Business ideas' },
      evicted: ['notes/business-ideas.md'],
    })
    linkNavigation.followWikiLink({ target: 'Business ideas', openInNewWindow: false }, host)
    await settle()
    expect(host.routes()).toEqual([])
    expect(noteCreation.created()).toEqual([])
    expect(operations.findByLabel('Opening link')).toMatchObject({
      status: 'failed',
      message: UNAVAILABLE_MESSAGE('Business ideas'),
    })
  })

  it('surfaces a resolution failure instead of silently doing nothing', async () => {
    const failure = new Error('index unavailable')
    const { linkNavigation, host, operations, logger } = setup({
      resolveOrCreateNoteWithTitle: () => Promise.reject(failure),
    })
    linkNavigation.followWikiLink({ target: 'Business ideas', openInNewWindow: false }, host)
    await settle()
    expect(operations.findByLabel('Opening link')).toMatchObject({
      status: 'failed',
      message: 'index unavailable',
    })
    expect(logger.getErrors()).toEqual([
      { message: 'wiki-link resolution failed:', cause: failure },
    ])
    expect(host.routes()).toEqual([])
  })

  it('drops a resolution that lands after the host went stale', async () => {
    const pending = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    const { linkNavigation, host } = setup({
      resolveOrCreateNoteWithTitle: () => pending.promise,
    })
    linkNavigation.followWikiLink({ target: 'Target', openInNewWindow: false }, host)
    host.leave()
    pending.resolve({ kind: 'resolved', path: 'notes/target.md' })
    await settle()
    expect(host.routes()).toEqual([])
  })

  it('drops an older resolution after a newer wiki-link activation', async () => {
    const pendingOlder = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    const { linkNavigation, host } = setup({
      resolveOrCreateNoteWithTitle: (title) =>
        title === 'Older'
          ? pendingOlder.promise
          : Promise.resolve({ kind: 'resolved', path: 'notes/newer.md' }),
    })
    linkNavigation.followWikiLink({ target: 'Older', openInNewWindow: false }, host)
    linkNavigation.followWikiLink({ target: 'Newer', openInNewWindow: false }, host)
    await settle()
    pendingOlder.resolve({ kind: 'resolved', path: 'notes/older.md' })
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'notes/newer.md' }])
  })
})

describe('followMarkdownNoteLink', () => {
  const files = { 'projects/roadmap/plan.md': '# Plan', 'projects/TASKS.md': '# Tasks' }

  it('opens a relative note link from the source note', async () => {
    const { linkNavigation, host, noteLinkResolver } = setup({ files })
    linkNavigation.followMarkdownNoteLink(
      {
        href: './roadmap/plan.md',
        sourcePath: 'projects/TASKS.md',
        openInNewWindow: false,
      },
      host,
    )
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'projects/roadmap/plan.md' }])
    expect(noteLinkResolver.calls()).toMatchObject([
      {
        kind: 'markdown',
        sourcePath: 'projects/TASKS.md',
        href: './roadmap/plan.md',
        generation: 7,
      },
    ])
  })

  it('opens the resolved note in a new window on request', async () => {
    const { linkNavigation, host, window } = setup({ files })
    linkNavigation.followMarkdownNoteLink(
      {
        href: './roadmap/plan.md',
        sourcePath: 'projects/TASKS.md',
        openInNewWindow: true,
      },
      host,
    )
    await settle()
    expect(window.openedNoteWindows()).toEqual(['reflect://note/projects%2Froadmap%2Fplan.md'])
    expect(host.routes()).toEqual([])
  })

  it('does nothing with no graph open', async () => {
    const { linkNavigation, host, noteLinkResolver } = setup({ files, graph: null })
    linkNavigation.followMarkdownNoteLink(
      {
        href: './roadmap/plan.md',
        sourcePath: 'projects/TASKS.md',
        openInNewWindow: false,
      },
      host,
    )
    await settle()
    expect(noteLinkResolver.calls()).toEqual([])
    expect(host.routes()).toEqual([])
  })

  it('does nothing and creates nothing for a missing target', async () => {
    const { linkNavigation, host, operations, noteFile } = setup({ files })
    linkNavigation.followMarkdownNoteLink(
      {
        href: './absent.md',
        sourcePath: 'projects/TASKS.md',
        openInNewWindow: false,
      },
      host,
    )
    await settle()
    expect(host.routes()).toEqual([])
    expect(operations.snapshot()).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it.each([
    [{ kind: 'ambiguous', paths: ['a.md', 'b.md'] } as const, AMBIGUOUS_MESSAGE('./plan.md')],
    [{ kind: 'unavailable', paths: ['a.md'] } as const, UNAVAILABLE_MESSAGE('./plan.md')],
  ])('refuses a target that resolves as $kind', async (resolution, message) => {
    const { linkNavigation, host, operations } = setup({
      noteLinkResolver: {
        resolveWikiTarget: () => ({ kind: 'missing' }),
        resolveMarkdownHref: () => resolution,
      },
    })
    linkNavigation.followMarkdownNoteLink(
      { href: './plan.md', sourcePath: 'projects/TASKS.md', openInNewWindow: false },
      host,
    )
    await settle()
    expect(operations.findByLabel('Opening link')).toMatchObject({ status: 'failed', message })
    expect(host.routes()).toEqual([])
  })

  it('surfaces a resolution failure', async () => {
    const failure = new Error('index unavailable')
    const { linkNavigation, host, operations, logger } = setup({
      noteLinkResolver: {
        resolveWikiTarget: () => ({ kind: 'missing' }),
        resolveMarkdownHref: () => Promise.reject(failure),
      },
    })
    linkNavigation.followMarkdownNoteLink(
      { href: './plan.md', sourcePath: 'projects/TASKS.md', openInNewWindow: false },
      host,
    )
    await settle()
    expect(operations.findByLabel('Opening link')).toMatchObject({
      status: 'failed',
      message: 'index unavailable',
    })
    expect(logger.getErrors()).toEqual([
      { message: 'markdown-link resolution failed:', cause: failure },
    ])
  })

  it('drops a resolution that lands after the host went stale', async () => {
    const pending = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    const { linkNavigation, host } = setup({
      noteLinkResolver: {
        resolveWikiTarget: () => ({ kind: 'missing' }),
        resolveMarkdownHref: () => pending.promise,
      },
    })
    linkNavigation.followMarkdownNoteLink(
      { href: './plan.md', sourcePath: 'projects/TASKS.md', openInNewWindow: false },
      host,
    )
    host.leave()
    pending.resolve({ kind: 'resolved', path: 'projects/plan.md' })
    await settle()
    expect(host.routes()).toEqual([])
  })
})

describe('followDeepLink', () => {
  it('dispatches a plain activation in this window', () => {
    const { linkNavigation, host, deepLinkIntake, window } = setup()
    linkNavigation.followDeepLink({ href: 'reflect://note/abc', openInNewWindow: false }, host)
    expect(deepLinkIntake.dispatched()).toEqual(['reflect://note/abc'])
    expect(window.openedNoteWindows()).toEqual([])
  })

  it('opens a new-window request in a secondary window without dispatching', async () => {
    const { linkNavigation, host, deepLinkIntake, window } = setup()
    linkNavigation.followDeepLink({ href: 'reflect://note/abc', openInNewWindow: true }, host)
    await settle()
    expect(window.openedNoteWindows()).toEqual(['reflect://note/abc'])
    expect(deepLinkIntake.dispatched()).toEqual([])
  })

  it('falls back to in-window dispatch when the window open is declined', async () => {
    const { linkNavigation, host, deepLinkIntake } = setup({ openNoteWindow: () => false })
    linkNavigation.followDeepLink({ href: 'reflect://note/older', openInNewWindow: true }, host)
    await settle()
    expect(deepLinkIntake.dispatched()).toEqual(['reflect://note/older'])
  })

  it('falls back to in-window dispatch when the window open rejects', async () => {
    const { linkNavigation, host, deepLinkIntake } = setup({
      openNoteWindow: () => Promise.reject(new Error('window creation failed')),
    })
    linkNavigation.followDeepLink({ href: 'reflect://note/older', openInNewWindow: true }, host)
    await settle()
    expect(deepLinkIntake.dispatched()).toEqual(['reflect://note/older'])
  })

  it('drops a failed fallback after the host went stale', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    const { linkNavigation, host, deepLinkIntake } = setup({
      openNoteWindow: () => pendingOpen.promise,
    })
    linkNavigation.followDeepLink({ href: 'reflect://note/older', openInNewWindow: true }, host)
    host.leave()
    pendingOpen.resolve(false)
    await settle()
    expect(deepLinkIntake.dispatched()).toEqual([])
  })

  it('drops a failed fallback after a newer note-link intent', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    let opens = 0
    const { linkNavigation, host, deepLinkIntake } = setup({
      openNoteWindow: () => {
        opens += 1
        return opens === 1 ? pendingOpen.promise : true
      },
    })
    linkNavigation.followDeepLink({ href: 'reflect://note/older', openInNewWindow: true }, host)
    linkNavigation.openNoteLink(
      { target: { kind: 'note', path: 'notes/newer-link.md' }, openInNewWindow: true },
      host,
    )
    pendingOpen.resolve(false)
    await settle()
    expect(deepLinkIntake.dispatched()).toEqual([])
  })

  it.each([
    'reflect://append?text=captured',
    'reflect://task?text=captured',
    'reflect://edit-notes?content=invalid',
  ])('does not cancel a pending failed fallback for non-address URL %s', async (url) => {
    const pendingOpen = Promise.withResolvers<boolean>()
    const { linkNavigation, host, deepLinkIntake, window } = setup({
      openNoteWindow: () => pendingOpen.promise,
    })
    linkNavigation.followDeepLink({ href: 'reflect://note/older', openInNewWindow: true }, host)
    linkNavigation.followDeepLink({ href: url, openInNewWindow: true }, host)
    pendingOpen.resolve(false)
    await settle()
    expect(window.openedNoteWindows()).toEqual(['reflect://note/older'])
    expect(deepLinkIntake.dispatched()).toEqual([url, 'reflect://note/older'])
  })

  it.each(['reflect://today', 'reflect://note/newer'])(
    'cancels a pending failed fallback for newer address URL %s',
    async (url) => {
      const pendingOpen = Promise.withResolvers<boolean>()
      const { linkNavigation, host, deepLinkIntake } = setup({
        openNoteWindow: () => pendingOpen.promise,
      })
      linkNavigation.followDeepLink({ href: 'reflect://note/older', openInNewWindow: true }, host)
      linkNavigation.followDeepLink({ href: url, openInNewWindow: false }, host)
      pendingOpen.resolve(false)
      await settle()
      expect(deepLinkIntake.dispatched()).toEqual([url])
    },
  )
})

describe('followMarkdownLink', () => {
  const source = { sourcePath: 'projects/TASKS.md' }

  it('opens an http(s) link in the OS browser', () => {
    const { linkNavigation, host, opener } = setup()
    linkNavigation.followMarkdownLink(
      { href: 'https://example.com', openInNewWindow: false, ...source },
      host,
    )
    expect(opener.openedUrls()).toEqual(['https://example.com'])
  })

  it('routes a reflect:// link through the deep-link intake, not the URL opener', () => {
    const { linkNavigation, host, opener, deepLinkIntake } = setup()
    linkNavigation.followMarkdownLink(
      { href: 'reflect://note/abc123', openInNewWindow: false, ...source },
      host,
    )
    expect(deepLinkIntake.dispatched()).toEqual(['reflect://note/abc123'])
    expect(opener.openedUrls()).toEqual([])
  })

  it('opens a reflect:// link in a secondary window on request', async () => {
    const { linkNavigation, host, window, deepLinkIntake } = setup()
    linkNavigation.followMarkdownLink(
      { href: 'reflect://note/abc123', openInNewWindow: true, ...source },
      host,
    )
    await settle()
    expect(window.openedNoteWindows()).toEqual(['reflect://note/abc123'])
    expect(deepLinkIntake.dispatched()).toEqual([])
  })

  it('opens a custom app scheme in its OS default app', () => {
    const { linkNavigation, host, opener } = setup()
    const href = 'x-devonthink-item://40C88434-68B6-4DCB-A258-754679764C3C'
    linkNavigation.followMarkdownLink({ href, openInNewWindow: false, ...source }, host)
    expect(opener.openedUrls()).toEqual([href])
  })

  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['blob:https://example.com/uuid'],
  ])('drops the unsafe scheme %s without opening anything', async (href) => {
    const { linkNavigation, host, opener, deepLinkIntake } = setup()
    linkNavigation.followMarkdownLink({ href, openInNewWindow: false, ...source }, host)
    await settle()
    expect(opener.openedUrls()).toEqual([])
    expect(deepLinkIntake.dispatched()).toEqual([])
    expect(host.routes()).toEqual([])
  })

  it('opens a relative note link from the source note', async () => {
    const { linkNavigation, host, opener } = setup({
      files: { 'projects/roadmap/plan.md': '# Plan' },
    })
    linkNavigation.followMarkdownLink(
      { href: './roadmap/plan.md', openInNewWindow: false, ...source },
      host,
    )
    await settle()
    expect(host.routes()).toEqual([{ kind: 'note', path: 'projects/roadmap/plan.md' }])
    expect(opener.openedUrls()).toEqual([])
  })

  it('opens an attachment link through the attachment opener, not the URL opener', async () => {
    const { linkNavigation, host, opener, attachments, noteLinkResolver } = setup()
    linkNavigation.followMarkdownLink(
      { href: 'assets/cat.png', openInNewWindow: false, ...source },
      host,
    )
    await settle()
    expect(attachments.opened()).toEqual(['assets/cat.png'])
    expect(opener.openedUrls()).toEqual([])
    expect(noteLinkResolver.calls()).toEqual([])
  })

  it('drops attachment and note links when the Markdown belongs to no note', async () => {
    const { linkNavigation, host, opener, attachments, noteLinkResolver, deepLinkIntake } = setup({
      files: { 'notes/foo.md': '# Foo' },
    })
    for (const href of ['assets/cat.png', 'notes/foo.md']) {
      linkNavigation.followMarkdownLink({ href, sourcePath: null, openInNewWindow: false }, host)
    }
    await settle()
    expect(attachments.opened()).toEqual([])
    expect(noteLinkResolver.calls()).toEqual([])
    expect(opener.openedUrls()).toEqual([])
    expect(deepLinkIntake.dispatched()).toEqual([])
    expect(host.routes()).toEqual([])
  })
})

describe('reportAmbiguousNoteTitle', () => {
  it('fails an operation with the given label', () => {
    const { linkNavigation, operations } = setup()
    linkNavigation.reportAmbiguousNoteTitle('Creating note', 'Plan')
    expect(operations.findByLabel('Creating note')).toMatchObject({
      status: 'failed',
      message: AMBIGUOUS_MESSAGE('Plan'),
    })
  })
})

describe('isOpenableExternalUrl', () => {
  it('allows absolute URLs of any scheme that is not blocked', () => {
    expect(isOpenableExternalUrl('https://example.com')).toBe(true)
    expect(isOpenableExternalUrl('bear://x-callback-url/open-note')).toBe(true)
    expect(isOpenableExternalUrl('mailto:hi@example.com')).toBe(true)
  })

  it('rejects blocked schemes and scheme-less hrefs', () => {
    for (const href of [
      'javascript:alert(1)',
      'VBScript:x',
      'data:text/html,x',
      'blob:https://example.com/uuid',
      'about:blank',
      'file:///etc/passwd',
      './plan.md',
      'notes/foo.md',
    ]) {
      expect(isOpenableExternalUrl(href), href).toBe(false)
    }
  })
})

describe('routeForTag', () => {
  it('opens All Notes filtered by the tag', () => {
    expect(routeForTag('work')).toEqual({ kind: 'allNotes', tag: 'work' })
  })
})
