import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge, subscribeFileChanges, type FileChange, type GraphInfo } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { createBackupController, type BackupState } from './backup-controller'

// providerFetch routes GitHub API calls through the Tauri HTTP plugin
// whenever a bridge is set — which it is in every test here.
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

afterEach(() => {
  setBridge(null)
  httpFetch.mockReset()
})

const GRAPH: GraphInfo = { root: '/g', name: 'G', cloudSync: null, generation: 3 }

const AUTH = JSON.stringify({ kind: 'pat', token: 'ghp_abc' })
const CLEAN_COMMIT = { committed: false, sha: null, ahead: 0, skippedLargeFiles: [] }
const UP_TO_DATE = { kind: 'upToDate', conflictedPaths: [], changedFiles: [] }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FakeOptions {
  auth?: string | null
  /** Hold the listen promise until `release()` (the teardown-race window). */
  gateListen?: boolean
  failStatus?: boolean
  /** Scripted `git_merge_remote` outcome (defaults to up-to-date). */
  mergeOutcome?: unknown
}

/** Bridge fake with a mutable repo status, recording every command. */
function fakeBridge(options: FakeOptions = {}) {
  const calls: string[] = []
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = []
  let auth = options.auth === undefined ? AUTH : options.auth
  const status = {
    initialized: true,
    branch: 'main',
    remoteUrl: 'https://github.com/alex/notes.git' as string | null,
    ahead: 0,
    behind: 0,
    inProgress: false,
  }
  let releaseListen: (() => void) | null = null
  setBridge({
    invoke: async (command, args) => {
      calls.push(command)
      invocations.push({ command, args })
      switch (command) {
        case 'git_status':
          if (options.failStatus === true) {
            throw { kind: 'io', message: 'broken repo' }
          }
          return status
        case 'git_setup':
          status.remoteUrl = typeof args.remoteUrl === 'string' ? args.remoteUrl : null
          return status
        case 'secret_get':
          return auth
        case 'secret_delete':
          auth = null
          return null
        case 'git_commit_all':
          return CLEAN_COMMIT
        case 'git_fetch':
          return { ahead: 0, behind: 0 }
        case 'git_merge_remote':
          return options.mergeOutcome ?? UP_TO_DATE
        case 'git_push':
          return { pushed: true, nonFastForward: false, rejectionMessage: null }
        case 'git_disconnect':
          status.remoteUrl = null
          return status
        default:
          return null
      }
    },
    listen: async () => {
      if (options.gateListen === true) {
        await new Promise<void>((resolve) => {
          releaseListen = resolve
        })
      }
      return () => {}
    },
  })
  return { calls, invocations, status, releaseListen: () => releaseListen?.() }
}

function trackStates(controller: ReturnType<typeof createBackupController>): BackupState[] {
  const states: BackupState[] = []
  controller.subscribe(() => states.push(controller.getState()))
  return states
}

describe('createBackupController', () => {
  it('reports disconnected when no credential is stored', async () => {
    const { calls } = fakeBridge({ auth: null })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    expect(controller.getState()).toEqual({ phase: 'disconnected' })
    expect(calls).not.toContain('git_commit_all')
    controller.dispose()
  })

  it('runs the launch pull when fully connected — and skips the idle push', async () => {
    const { calls } = fakeBridge()
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    const states = trackStates(controller)
    await controller.start()
    await vi.waitFor(() => {
      expect(calls).toContain('git_merge_remote')
    })

    expect(states.at(-1)).toMatchObject({ phase: 'connected', status: { state: 'idle' } })
    // Both sides in step: the cycle must end without a network push.
    expect(calls).not.toContain('git_push')
    controller.dispose()
  })

  it('disposing mid-subscribe stops the engine before any git work runs', async () => {
    const { calls, releaseListen } = fakeBridge({ gateListen: true })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    const started = controller.start()
    await vi.waitFor(() => {
      expect(calls).toContain('git_status')
    })

    controller.dispose() // teardown wins the race against the subscription
    releaseListen()
    await started

    expect(calls).not.toContain('git_commit_all')
    expect(calls.filter((command) => command === 'git_status')).toHaveLength(1)
  })

  it('disconnectGraph drops the remote and lands on disconnected', async () => {
    const { calls } = fakeBridge()
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    await controller.disconnectGraph()

    expect(calls).toContain('git_disconnect')
    expect(controller.getState()).toEqual({ phase: 'disconnected' })
    controller.dispose()
  })

  it('a failed probe tears down to disconnected instead of leaving a zombie', async () => {
    const { calls } = fakeBridge({ failStatus: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    expect(controller.getState()).toEqual({ phase: 'disconnected' })
    expect(calls).not.toContain('git_commit_all')
    controller.dispose()
    errorSpy.mockRestore()
  })

  it('connectNewRepo creates a private repo and connects to its default branch', async () => {
    const { invocations } = fakeBridge()
    const requests: Array<Record<string, unknown>> = []
    httpFetch.mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(
        {
          full_name: 'alex/g-backup',
          private: true,
          default_branch: 'main',
          html_url: 'https://github.com/alex/g-backup',
        },
        201,
      )
    })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })

    await controller.connectNewRepo('g-backup')

    expect(requests[0]).toMatchObject({ name: 'g-backup', private: true })
    const setup = invocations.find(({ command }) => command === 'git_setup')
    expect(setup?.args).toMatchObject({
      remoteUrl: 'https://github.com/alex/g-backup.git',
      branch: 'main',
      generation: 3,
    })
    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      repo: { owner: 'alex', name: 'g-backup' },
    })
    controller.dispose()
  })

  it('connectExistingRepo reports a missing repo without touching the graph', async () => {
    const { calls } = fakeBridge()
    httpFetch.mockImplementation(async () => jsonResponse({ message: 'Not Found' }, 404))
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })

    expect(await controller.connectExistingRepo({ owner: 'alex', name: 'gone' })).toBe('notFound')
    expect(calls).not.toContain('git_setup')
    controller.dispose()
  })

  it('connectExistingRepo demands explicit consent before a public repo', async () => {
    const { calls, invocations } = fakeBridge()
    // A fresh Response per call — a body is single-read.
    httpFetch.mockImplementation(async () =>
      jsonResponse({
        full_name: 'alex/public-notes',
        private: false,
        default_branch: 'master',
        html_url: 'https://github.com/alex/public-notes',
      }),
    )
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    const ref = { owner: 'alex', name: 'public-notes' }

    expect(await controller.connectExistingRepo(ref)).toBe('needsPublicConfirm')
    expect(calls).not.toContain('git_setup')

    expect(await controller.connectExistingRepo(ref, { allowPublic: true })).toBe('connected')
    const setup = invocations.find(({ command }) => command === 'git_setup')
    // The repo's default branch is where the existing backup history lives.
    expect(setup?.args).toMatchObject({ branch: 'master' })
    controller.dispose()
  })

  it('signOut clears the machine credential and lands on disconnected', async () => {
    const { calls } = fakeBridge()
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()
    expect(controller.getState()).toMatchObject({ phase: 'connected' })

    await controller.signOut()

    expect(calls).toContain('secret_delete')
    expect(controller.getState()).toEqual({ phase: 'disconnected' })
    controller.dispose()
  })

  it('window focus and online events trigger a sync — until dispose', async () => {
    const { calls } = fakeBridge()
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()
    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(1)
    })

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(2)
    })
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(3)
    })

    controller.dispose()
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(3)
  })

  it('fans a pull’s indexable writes to the local file-changes channel', async () => {
    fakeBridge({
      mergeOutcome: {
        kind: 'merged',
        conflictedPaths: [],
        changedFiles: [
          { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 123 },
          { path: 'daily/2026-06-11.md', kind: 'remove' },
          { path: 'assets/photo.png', kind: 'upsert', modifiedMs: 456 }, // not indexable
        ],
      },
    })
    const batches: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => batches.push(changes))
    const controller = createBackupController({ graph: GRAPH, indexGeneration: null })
    await controller.start()

    await vi.waitFor(() => {
      expect(batches).toHaveLength(1)
    })
    expect(batches[0]).toEqual([
      { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 123 },
      { path: 'daily/2026-06-11.md', kind: 'remove' },
    ])
    controller.dispose()
    unlisten()
  })
})
