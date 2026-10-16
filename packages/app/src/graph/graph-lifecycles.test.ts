import { describe, expect, it } from 'vitest'
import { createGraphSession, type GraphRole, type GraphServicesDeps } from '@reflect/core'
import {
  createTestCoreServices,
  createTestPlatformService,
  trackAssetDescriptionSessions,
  type TestCoreServices,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { createTestMobileOnboardingService } from '../testing/mobile-onboarding.ts'
import { createAppGraphServices, whileActive } from './graph-lifecycles.ts'

const ICLOUD_ROOT = '/Users/me/Library/Mobile Documents/iCloud~reflect/Documents/notes'

/**
 * The deps of the per-session services, taken from the test core.
 */
function graphDeps(core: TestCoreServices): GraphServicesDeps {
  const { icloudNative, fileChanges, indexLifecycle, activity, clock, logger } = core
  return {
    backup: {
      git: core.gitRepository,
      syncEngines: core.syncEngines,
      githubAuth: core.githubAuth,
      githubRepos: core.githubRepos,
      fileChanges,
      indexLifecycle,
      progress: core.progress,
      clock,
      activity,
      platform: core.platform,
      persistenceFlush: core.persistenceFlush,
      icloudNative,
      logger,
    },
    icloudSync: {
      icloudNative,
      fileChanges,
      indexLifecycle,
      openDocuments: core.openDocuments,
      activity,
      clock,
      logger,
      progress: core.progress,
    },
    icloudDownload: { icloudNative, activity, clock, logger },
    capture: core.capture,
    assetDescription: core.assetDescription,
    chatSessions: core.chatSessions,
    attachments: core.attachments,
    graphSession: core.graphSession,
  }
}

function setup(options?: { role?: GraphRole; root?: string; platform?: TestPlatformOptions }) {
  const core = createTestCoreServices()
  const sessions = trackAssetDescriptionSessions(core.assetDescription)
  const platform = createTestPlatformService(options?.platform)
  const mobileOnboarding = createTestMobileOnboardingService()
  const controller = new AbortController()
  const session = createGraphSession(
    {
      root: options?.root ?? '/g',
      name: 'g',
      generation: 3,
      indexGeneration: 5,
      role: options?.role ?? 'main',
    },
    controller.signal,
  )
  const graph = createAppGraphServices(session, graphDeps(core), {
    platform,
    settings: core.settings,
    mobileOnboarding,
  })
  const downloads = () =>
    core.icloudNative.calls().filter((call) => call.method === 'downloadPending').length
  return { core, controller, session, graph, mobileOnboarding, downloads, sessions }
}

describe('createAppGraphServices', () => {
  it('runs every lifecycle of a desktop main window', () => {
    const context = setup()
    expect(context.graph).toMatchObject({ session: context.session, role: 'main' })
    expect(context.graph.backup).not.toBeNull()
    expect(context.core.capture.sessions()).toHaveLength(1)
    expect(context.sessions()).toHaveLength(1)
  })

  it('runs only the chat session and the catalog watch in a note window', () => {
    const context = setup({ role: 'note-window', root: ICLOUD_ROOT })
    expect(context.graph.backup).toBeNull()
    expect(context.core.capture.sessions()).toEqual([])
    expect(context.sessions()).toEqual([])
    expect(context.core.attachments.watchers()).toBe(1)
  })

  it('opens and disposes the asset description session as `describeAssets` flips', () => {
    const context = setup()
    const { sessions } = context
    expect(sessions().map((session) => session.disposed)).toEqual([false])

    context.core.settings.update({ describeAssets: false })
    expect(sessions().map((session) => session.disposed)).toEqual([true])

    context.core.settings.update({ describeAssets: true })
    expect(sessions().map((session) => session.disposed)).toEqual([true, false])

    context.controller.abort()
    expect(sessions().map((session) => session.disposed)).toEqual([true, true])
    context.core.settings.update({ describeAssets: false })
    context.core.settings.update({ describeAssets: true })
    expect(sessions()).toHaveLength(2)
  })

  it('describes no assets on mobile', () => {
    const context = setup({ platform: { appPlatform: 'ios' } })
    expect(context.sessions()).toEqual([])
  })

  it('refreshes downloads while the mobile graph is stored in iCloud', () => {
    const context = setup({ root: ICLOUD_ROOT, platform: { appPlatform: 'ios' } })
    expect(context.downloads()).toBe(0)

    context.mobileOnboarding.setState({ kind: 'icloud' })
    expect(context.downloads()).toBe(1)

    context.controller.abort()
    context.mobileOnboarding.setState({ kind: 'local' })
    context.mobileOnboarding.setState({ kind: 'icloud' })
    expect(context.downloads()).toBe(1)
  })

  it('leaves nothing running for a session that already ended', () => {
    const context = setup()
    context.controller.abort()
    const core = createTestCoreServices()
    const sessions = trackAssetDescriptionSessions(core.assetDescription)
    const ended = new AbortController()
    ended.abort()
    createAppGraphServices(
      createGraphSession(
        { root: '/g', name: 'g', generation: 3, indexGeneration: 5 },
        ended.signal,
      ),
      graphDeps(core),
      {
        platform: core.platform,
        settings: core.settings,
        mobileOnboarding: context.mobileOnboarding,
      },
    )
    const closed = sessions()
    expect(closed.length).toBeGreaterThan(0)
    expect(closed.every((session) => session.disposed)).toBe(true)
    expect(core.attachments.watchers()).toBe(0)
  })
})

describe('whileActive', () => {
  it('opens while active and closes on the change and on stop', () => {
    let active = false
    const listeners = new Set<() => void>()
    const events: string[] = []
    const stop = whileActive(
      () => active,
      (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      () => {
        events.push('open')
        return () => {
          events.push('close')
        }
      },
    )
    const notify = () => {
      for (const listener of listeners) {
        listener()
      }
    }
    expect(events).toEqual([])
    active = true
    notify()
    notify()
    expect(events).toEqual(['open'])
    stop()
    expect(events).toEqual(['open', 'close'])
    expect(listeners.size).toBe(0)
  })
})
