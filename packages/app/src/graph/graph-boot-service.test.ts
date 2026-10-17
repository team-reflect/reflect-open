import { describe, expect, it, vi } from 'vitest'
import {
  createPathService,
  createPosixPathTransport,
  type RecentGraph,
  type WindowBootstrap,
  AppError,
} from '@reflect/core'
import {
  createTestDeepLinkIntakeService,
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestIndexLifecycleService,
  createTestIndexStoreService,
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestPlatformService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { createDeepLinkRouter } from '../navigation/deep-link-router.ts'
import type { Route } from '../navigation/route.ts'
import { createTestDialogService } from '../testing/dialog.ts'
import { createTestWindowService } from '../testing/window.ts'
import { createGraphBootService } from './graph-boot-service.ts'

const BOOT: WindowBootstrap = {
  graph: { root: '/g', name: 'g', generation: 3 },
  indexGeneration: 5,
  initialDeepLink: 'reflect://note/notes%2Ffoo.md',
}

interface SetupOptions {
  recents?: RecentGraph[]
  platform?: TestPlatformOptions
  windowLabel?: string
  bootstrap?: WindowBootstrap
  /**
   * Hold every `graph_open` until `resolveOpen(root)`.
   */
  holdOpens?: boolean
}

/**
 * The boot flows over a real graph session whose bridge keeps recents and
 * counts graph generations, a test window, and a recording deep-link router.
 */
function setup(options?: SetupOptions) {
  let recents = [...(options?.recents ?? [])]
  let generation = 0
  const pendingOpens = new Map<string, () => void>()
  const failures = { recents: false }
  const logger = createTestLoggerService()
  const ipc = createTestIpcBridgeService({
    logger,
    commands: {
      recent_graphs: () => {
        if (failures.recents) {
          throw new AppError('io', 'recents are corrupt')
        }
        return recents
      },
      forget_recent: (args) => {
        recents = recents.filter((recent) => recent.root !== args['root'])
        return null
      },
      graph_open: async (args) => {
        const root = String(args['path'])
        if (options?.holdOpens ?? false) {
          await new Promise<void>((resolve) => {
            pendingOpens.set(root, resolve)
          })
        }
        generation += 1
        return { root, name: root.split('/').findLast(Boolean) ?? '', generation }
      },
      graph_delete: () => null,
    },
  })
  const noteFile = createTestNoteFileService()
  const indexStore = createTestIndexStoreService()
  const fileChanges = createTestFileChangeService()
  const indexLifecycle = createTestIndexLifecycleService({
    indexStore,
    noteFile,
    fileChanges,
    logger,
    graphSession: {
      getState: () => session.getState(),
      subscribe: (listener) => session.subscribe(listener),
    },
  })
  const window = createTestWindowService({
    ...(options?.windowLabel === undefined ? {} : { label: options.windowLabel }),
    ...(options?.bootstrap === undefined ? {} : { bootstrap: options.bootstrap }),
  })
  const session = createTestGraphSessionService({
    ipc,
    indexLifecycle,
    indexStore,
    noteFile,
    fileChanges,
    role: window.isMainWindow() ? 'main' : 'note-window',
    logger,
  })
  const dialog = createTestDialogService()
  const routes: Route[] = []
  const dispatched: string[] = []
  const deepLinkRouter = createDeepLinkRouter({
    intake: createTestDeepLinkIntakeService(),
    logger,
    graphSession: session,
  })
  vi.spyOn(deepLinkRouter, 'setInitialWindowRoute').mockImplementation((route) => {
    routes.push(route)
  })
  vi.spyOn(deepLinkRouter, 'dispatch').mockImplementation((url) => {
    dispatched.push(url)
  })
  const boot = createGraphBootService({
    graphSession: session,
    window,
    dialog,
    path: createPathService({ transport: createPosixPathTransport('/Users/me') }),
    platform: createTestPlatformService(options?.platform),
    deepLinkRouter,
    logger,
  })
  return {
    boot,
    session,
    window,
    dialog,
    logger,
    failures,
    routes,
    dispatched,
    commands: () => ipc.calls().map((call) => call.command),
    hasPendingOpen: (root: string) => pendingOpens.has(root),
    resolveOpen: (root: string) => {
      pendingOpens.get(root)?.()
      pendingOpens.delete(root)
    },
  }
}

/**
 * Boot a desktop main window and wait until its boot path settled.
 */
async function bootDesktop(options?: SetupOptions) {
  const context = setup(options)
  const stop = context.boot.boot()
  await expect.poll(() => context.session.getState().status).not.toBe('loading')
  await expect.poll(() => context.session.getState().status).not.toBe('opening')
  return { ...context, stop }
}

describe('GraphBootService desktop boot', () => {
  it('starts at the chooser when there are no recents', async () => {
    const { session } = await bootDesktop()
    expect(session.getState()).toMatchObject({
      status: 'choosing',
      graph: null,
      session: null,
      error: null,
    })
  })

  it('reopens the most recent graph and seeds no window route', async () => {
    const recents = [
      { root: '/known', name: 'known', openedMs: 2 },
      { root: '/older', name: 'older', openedMs: 1 },
    ]
    const context = await bootDesktop({ recents })
    expect(context.session.getState()).toMatchObject({
      status: 'ready',
      graph: { root: '/known', name: 'known', generation: 1 },
      indexGeneration: 1,
      recents,
    })
    expect(context.routes).toEqual([])
  })

  it('surfaces a failed recents read', async () => {
    const context = setup()
    context.failures.recents = true
    context.boot.boot()
    await expect.poll(() => context.session.getState().status).toBe('choosing')
    expect(context.session.getState().error).toMatch(/recents are corrupt/)
  })

  it('opens nothing when the boot was stopped before the recents arrived', async () => {
    const context = setup({ recents: [{ root: '/known', name: 'known', openedMs: 1 }] })
    const stop = context.boot.boot()
    stop()
    await expect.poll(() => context.session.getState().recents).toHaveLength(1)
    await Promise.resolve()
    expect(context.session.getState().status).toBe('loading')
    expect(context.commands()).not.toContain('graph_open')
  })

  it('waits for the host on mobile', async () => {
    const context = setup({
      platform: { appPlatform: 'ios' },
      recents: [{ root: '/known', name: 'known', openedMs: 1 }],
    })
    context.boot.boot()
    await Promise.resolve()
    expect(context.session.getState().status).toBe('loading')
    expect(context.commands()).toEqual([])
  })
})

describe('GraphBootService note-window boot', () => {
  function bootNoteWindow(bootstrap?: WindowBootstrap) {
    const context = setup({
      windowLabel: 'note-1',
      ...(bootstrap === undefined ? {} : { bootstrap }),
    })
    return { ...context, stop: context.boot.boot() }
  }

  it('adopts the open sessions and seeds the router from a path-shaped link', async () => {
    const context = bootNoteWindow(BOOT)
    await expect.poll(() => context.session.getState().status).toBe('ready')
    expect(context.session.getState()).toMatchObject({
      graph: BOOT.graph,
      indexGeneration: 5,
      session: { root: '/g', generation: 3, indexGeneration: 5, role: 'note-window' },
    })
    expect(context.commands()).toEqual([])
    // ⌘-click links resolve synchronously: the route slot is seeded and the
    // intake is bypassed, so the window never flashes today's daily note.
    expect(context.routes).toEqual([{ kind: 'note', path: 'notes/foo.md' }])
    expect(context.dispatched).toEqual([])
    // A repeat ⌘-click on its target re-navigates the window.
    context.window.emitNavigate('reflect://note/notes%2Fbar.md')
    expect(context.dispatched).toEqual(['reflect://note/notes%2Fbar.md'])
  })

  it('falls back to the intake for a target only the index can answer', async () => {
    const context = bootNoteWindow({ ...BOOT, initialDeepLink: 'reflect://note/Meeting%20Notes' })
    await expect.poll(() => context.session.getState().status).toBe('ready')
    expect(context.routes).toEqual([])
    expect(context.dispatched).toEqual(['reflect://note/Meeting%20Notes'])
  })

  it('skips the deep-link dispatch when none is pending (a reload)', async () => {
    const context = bootNoteWindow({ ...BOOT, initialDeepLink: null })
    await expect.poll(() => context.session.getState().status).toBe('ready')
    expect(context.routes).toEqual([])
    expect(context.dispatched).toEqual([])
  })

  it('acts on the drained deep link but adopts nothing once stopped', async () => {
    const context = bootNoteWindow(BOOT)
    context.stop()
    await expect.poll(() => context.routes).toHaveLength(1)
    expect(context.session.getState().status).toBe('loading')
    context.window.emitNavigate('reflect://note/notes%2Fbar.md')
    expect(context.dispatched).toEqual([])
  })

  it('parks the window on a failed bootstrap', async () => {
    const context = bootNoteWindow()
    await expect.poll(() => context.session.getState().status).toBe('choosing')
    expect(context.session.getState().error).toContain('no bootstrap configured')
    expect(context.session.getState().graph).toBeNull()
  })

  it('stops following navigation requests when stopped', async () => {
    const context = bootNoteWindow(BOOT)
    await expect.poll(() => context.session.getState().status).toBe('ready')
    context.stop()
    context.window.emitNavigate('reflect://note/notes%2Fbar.md')
    expect(context.dispatched).toEqual([])
  })

  it('refuses graph switches', async () => {
    const context = bootNoteWindow(BOOT)
    await expect.poll(() => context.session.getState().status).toBe('ready')

    await expect(context.boot.openRecent('/other')).resolves.toBe(false)
    await context.boot.chooseGraph()

    expect(context.session.getState().graph).toEqual(BOOT.graph)
    expect(context.window.closeSecondaryWindowsCalls()).toBe(0)
    expect(context.logger.getWarnings().map((entry) => entry.message)).toEqual([
      'opening a graph is only available from the main window',
      'switching graphs is only available from the main window',
    ])
  })
})

describe('GraphBootService note windows', () => {
  const recents = [{ root: '/known', name: 'known', openedMs: 1 }]

  it('closes note windows BEFORE the backend open bumps the session', async () => {
    // Note windows adopted the outgoing session; their close-requested
    // flushes must land against its still-valid generation, so the close
    // precedes graph_open (bump-first would reject the saves).
    const context = await bootDesktop({ holdOpens: true })
    const opened = context.boot.openRecent('/a')
    await expect.poll(() => context.hasPendingOpen('/a')).toBe(true)
    expect(context.window.closeSecondaryWindowsCalls()).toBe(1)
    context.resolveOpen('/a')
    await opened
  })

  it('leaves note windows alone on mobile', async () => {
    const context = setup({ platform: { appPlatform: 'ios' } })
    await expect(context.boot.openRecent('/a')).resolves.toBe(true)
    await context.boot.chooseGraph()
    expect(context.window.closeSecondaryWindowsCalls()).toBe(0)
  })

  it('closes them before forgetting the open graph, and only then', async () => {
    const context = await bootDesktop({
      recents: [...recents, { root: '/older', name: 'older', openedMs: 0 }],
    })
    // The boot open closed them once.
    expect(context.window.closeSecondaryWindowsCalls()).toBe(1)

    await context.boot.forgetRecent('/older')
    expect(context.window.closeSecondaryWindowsCalls()).toBe(1)

    await context.boot.forgetRecent('/known')
    expect(context.window.closeSecondaryWindowsCalls()).toBe(2)
    expect(context.session.getState()).toMatchObject({ status: 'choosing', graph: null })
  })

  it('closes them before deleting the open graph', async () => {
    const context = await bootDesktop({ recents })
    await context.boot.deleteGraph()
    expect(context.commands()).toContain('graph_delete')
    expect(context.window.closeSecondaryWindowsCalls()).toBe(2)
    expect(context.session.getState()).toMatchObject({ status: 'choosing', graph: null })
  })

  it('closes them and the graph to show the chooser, without the folder picker', async () => {
    const context = await bootDesktop({ recents })

    await context.boot.chooseGraph()

    expect(context.session.getState()).toMatchObject({
      status: 'choosing',
      graph: null,
      indexGeneration: null,
      indexing: false,
      recents,
    })
    expect(context.window.closeSecondaryWindowsCalls()).toBe(2)
    expect(context.dialog.calls()).toEqual([])
  })
})

describe('GraphBootService folder picker', () => {
  it('opens the picked folder, suggesting iCloud Drive on a macOS first run', async () => {
    const context = await bootDesktop()
    context.dialog.setFolder('/fresh')

    await context.boot.pickAndOpen()

    expect(context.dialog.calls()).toEqual([
      {
        kind: 'folder',
        options: {
          title: 'Choose a graph folder',
          defaultPath: '/Users/me/Library/Mobile Documents/com~apple~CloudDocs',
        },
      },
    ])
    expect(context.session.getState()).toMatchObject({ status: 'ready', graph: { root: '/fresh' } })
    expect(context.window.closeSecondaryWindowsCalls()).toBe(1)
  })

  it('suggests no folder once a graph is known', async () => {
    const context = await bootDesktop({ recents: [{ root: '/known', name: 'known', openedMs: 1 }] })
    await context.boot.pickAndOpen()
    expect(context.dialog.calls()).toEqual([
      { kind: 'folder', options: { title: 'Choose a graph folder' } },
    ])
    // A cancelled picker changes nothing.
    expect(context.session.getState().graph?.root).toBe('/known')
  })

  it('suggests no folder off macOS', async () => {
    const context = await bootDesktop({ platform: { isMacosDesktop: false } })
    await context.boot.pickAndOpen()
    expect(context.dialog.calls()).toEqual([
      { kind: 'folder', options: { title: 'Choose a graph folder' } },
    ])
  })

  it('surfaces a picker failure without leaving the open graph', async () => {
    const context = await bootDesktop({ recents: [{ root: '/known', name: 'known', openedMs: 1 }] })
    context.dialog.pickFolder = async () => {
      throw new Error('picker crashed')
    }
    await context.boot.pickAndOpen()
    expect(context.session.getState()).toMatchObject({ status: 'ready', error: 'picker crashed' })
  })
})
