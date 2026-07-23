import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emitFileChanges,
  setBridge,
  subscribeFileChanges,
  type FileChange,
  type GraphInfo,
} from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { setPlatformSurface } from '@/lib/platform-surface'
import { createBackupController, type BackupState } from './backup-controller'

// providerFetch routes GitHub API calls through the Tauri HTTP plugin
// whenever a bridge is set — which it is in every test here.
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

afterEach(() => {
  setBridge(null)
  httpFetch.mockReset()
})

const GRAPH: GraphInfo = { root: '/g', name: 'G', generation: 3 }

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
  /** Hold the direct index write until `releaseIndexApply()` (the convergence barrier). */
  gateIndexApply?: boolean
  /** Make every direct index write throw (the projection-failure path). */
  failIndexApply?: boolean
  /** Hold the listen promise until `release()` (the teardown-race window). */
  gateListen?: boolean
  failStatus?: boolean
  /** Scripted `git_merge_remote` outcome (defaults to up-to-date). */
  mergeOutcome?: unknown
  /** Per-call merge outcomes for retry/convergence tests. */
  mergeOutcomes?: unknown[]
  /** Per-call push outcomes for retry/convergence tests. */
  pushOutcomes?: unknown[]
  /** The graph's origin (defaults to a GitHub HTTPS remote; null = none). */
  remoteUrl?: string | null
  /** Whether the graph already has a repository (defaults to true). */
  initialized?: boolean
}

/** Bridge fake with a mutable repo status, recording every command. */
function fakeBridge(options: FakeOptions = {}) {
  const calls: string[] = []
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = []
  let auth = options.auth === undefined ? AUTH : options.auth
  const status = {
    initialized: options.initialized ?? true,
    branch: 'main',
    remoteUrl:
      options.remoteUrl === undefined
        ? ('https://github.com/alex/notes.git' as string | null)
        : options.remoteUrl,
    ahead: 0,
    behind: 0,
    inProgress: false,
  }
  let releaseListen: (() => void) | null = null
  let releaseIndexApply: (() => void) | null = null
  let indexApplyCount = 0
  const mergeOutcomes = [...(options.mergeOutcomes ?? [])]
  const pushOutcomes = [...(options.pushOutcomes ?? [])]
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
          status.initialized = true
          status.remoteUrl = typeof args['remoteUrl'] === 'string' ? args['remoteUrl'] : null
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
          return mergeOutcomes.shift() ?? options.mergeOutcome ?? UP_TO_DATE
        case 'git_push':
          return (
            pushOutcomes.shift() ?? {
              pushed: true,
              nonFastForward: false,
              rejectionMessage: null,
            }
          )
        case 'db_query':
          return []
        case 'note_read':
          return '# Remote note\n'
        case 'index_apply_batch':
          indexApplyCount += 1
          if (options.failIndexApply === true) {
            throw { kind: 'io', message: 'index write failed' }
          }
          if (options.gateIndexApply === true && indexApplyCount === 1) {
            await new Promise<void>((resolve) => {
              releaseIndexApply = resolve
            })
          }
          return null
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
  return {
    calls,
    invocations,
    status,
    releaseListen: () => releaseListen?.(),
    releaseIndexApply: () => releaseIndexApply?.(),
  }
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

  it('adopts a hand-wired generic remote without any stored credential', async () => {
    // Plan 16 V1: a non-GitHub origin (here SSH) needs no GitHub sign-in —
    // its credentials live with the user's git tooling, resolved in Rust.
    const { calls, invocations } = fakeBridge({
      auth: null,
      remoteUrl: 'git@gitlab.com:alex/notes.git',
    })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()
    await vi.waitFor(() => {
      expect(calls).toContain('git_fetch')
    })

    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      remoteUrl: 'git@gitlab.com:alex/notes.git',
      repo: null,
    })
    const fetch = invocations.find(({ command }) => command === 'git_fetch')
    expect(fetch?.args).toMatchObject({ token: null })
    controller.dispose()
  })

  it('never offers the GitHub token to a generic remote', async () => {
    // A GitHub credential in the keychain + a foreign origin: the token must
    // not ride along as basic auth to a host the user never authorized.
    const { invocations } = fakeBridge({ remoteUrl: 'git@gitlab.com:alex/notes.git' })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()
    await vi.waitFor(() => {
      expect(invocations.some(({ command }) => command === 'git_fetch')).toBe(true)
    })

    for (const { command, args } of invocations) {
      if (command === 'git_fetch' || command === 'git_push') {
        expect(args).toMatchObject({ token: null })
      }
    }
    controller.dispose()
  })

  it('refuses a generic HTTPS remote at adoption with the SSH suggestion', async () => {
    // A *public* generic HTTPS remote would pull anonymously and only fail
    // on push — edits arriving while the user's own never leave. The guard
    // surfaces the error before the engine ever starts.
    const { calls } = fakeBridge({ remoteUrl: 'https://gitlab.com/alex/notes.git' })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      repo: null,
      status: { state: 'error', errorKind: 'rejected' },
    })
    const state = controller.getState()
    if (state.phase === 'connected' && state.status.state === 'error') {
      expect(state.status.message).toContain('git remote set-url')
    }

    // No engine: no git work now, and focus events stay inert.
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).not.toContain('git_commit_all')
    expect(calls).not.toContain('git_fetch')
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

  it('initializes local history on desktop when no backup is configured', async () => {
    const { calls, invocations } = fakeBridge({ auth: null, initialized: false, remoteUrl: null })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    // The UI never learns about local history — the graph reads as disconnected.
    expect(controller.getState()).toEqual({ phase: 'disconnected' })
    const setup = invocations.find(({ command }) => command === 'git_setup')
    expect(setup?.args).toMatchObject({ remoteUrl: null, branch: null, generation: 3 })
    await vi.waitFor(() => {
      expect(calls).toContain('git_commit_all') // first snapshot on launch
    })
    expect(calls).not.toContain('git_fetch')
    expect(calls).not.toContain('git_push')
    controller.dispose()
  })

  it('local history keeps committing on edits — still with no network', async () => {
    // A repo without a remote (e.g. after disconnectGraph) needs no git_setup.
    const commitCount = (calls: string[]): number =>
      calls.filter((command) => command === 'git_commit_all').length
    const { calls } = fakeBridge({ auth: null, remoteUrl: null })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1)
    })
    expect(calls).not.toContain('git_setup')

    vi.useFakeTimers()
    try {
      emitFileChanges([{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }])
      await vi.advanceTimersByTimeAsync(30_000)
    } finally {
      vi.useRealTimers()
    }
    expect(commitCount(calls)).toBe(2)
    expect(calls).not.toContain('git_fetch')
    expect(calls).not.toContain('git_push')
    controller.dispose()
  })

  it('never starts local history on mobile', async () => {
    setPlatformSurface({ mobileApp: true })
    try {
      const { calls } = fakeBridge({ auth: null, initialized: false, remoteUrl: null })
      const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
      await controller.start()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(controller.getState()).toEqual({ phase: 'disconnected' })
      expect(calls).not.toContain('git_setup')
      expect(calls).not.toContain('git_commit_all')
      controller.dispose()
    } finally {
      setPlatformSurface({ mobileApp: false })
    }
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

  it('a resume firing both visibility and focus runs one deduped cycle', async () => {
    // WKWebView emits `visibilitychange` AND `focus` on one app foreground
    // (desktop unminimize can too). Without the dedupe the second event
    // queues a follow-up cycle — double network work on every resume.
    const { calls } = fakeBridge()
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()
    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(1)
    })

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(2)
    })
    // Let any wrongly-queued follow-up cycle surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(2)
    controller.dispose()
  })

  it('going hidden does not trigger a cycle (backgrounding is the flush path)', async () => {
    const { calls } = fakeBridge()
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()
    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(1)
    })

    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(1)

    visibility.mockRestore()
    controller.dispose()
  })

  it('defers mobile launch, online, and debounce cycles until foreground', async () => {
    setPlatformSurface({ mobileApp: true })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const { calls } = fakeBridge()
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    try {
      await controller.start()
      await new Promise((resolve) => setTimeout(resolve, 0))

      // Adoption may probe status/auth while hidden, but the launch cycle must
      // not acquire the Git index or touch the network.
      expect(calls).not.toContain('git_commit_all')
      expect(calls).not.toContain('git_fetch')

      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => {
        expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(1)
      })
      expect(calls.filter((command) => command === 'git_fetch')).toHaveLength(1)

      visibility.mockReturnValue('hidden')
      vi.useFakeTimers()
      emitFileChanges([{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }])
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(10_000)

      // Both the immediate online trigger and the edit's 10s mobile debounce
      // are dropped while hidden.
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(1)
      expect(calls.filter((command) => command === 'git_fetch')).toHaveLength(1)

      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.runAllTimersAsync()
      expect(calls.filter((command) => command === 'git_commit_all')).toHaveLength(2)
      // Foreground replay is full, so it fetches rather than merely pushing
      // the edit that arrived while hidden.
      expect(calls.filter((command) => command === 'git_fetch')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
      controller.dispose()
      visibility.mockRestore()
      setPlatformSurface({ mobileApp: false })
    }
  })

  it('an edit backs up after 30s idle on desktop, 10s on mobile', async () => {
    const commitCount = (calls: string[]): number =>
      calls.filter((command) => command === 'git_commit_all').length

    async function debouncedCommitDelay(mobile: boolean): Promise<number> {
      setPlatformSurface({ mobileApp: mobile })
      const { calls } = fakeBridge()
      const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
      try {
        await controller.start()
        await vi.waitFor(() => {
          expect(commitCount(calls)).toBe(1) // the launch pull's commit
        })
        vi.useFakeTimers()
        emitFileChanges([{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }])
        await vi.advanceTimersByTimeAsync(10_000)
        if (commitCount(calls) > 1) {
          return 10_000
        }
        await vi.advanceTimersByTimeAsync(20_000)
        return commitCount(calls) > 1 ? 30_000 : Number.POSITIVE_INFINITY
      } finally {
        vi.useRealTimers()
        setPlatformSurface({ mobileApp: false })
        controller.dispose()
      }
    }

    expect(await debouncedCommitDelay(false)).toBe(30_000)
    expect(await debouncedCommitDelay(true)).toBe(10_000)
  })

  it('fans a pull’s writes whole to the local file-changes channel — consumers filter by path', async () => {
    fakeBridge({
      mergeOutcome: {
        kind: 'merged',
        conflictedPaths: [],
        changedFiles: [
          { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 123 },
          { path: 'daily/2026-06-11.md', kind: 'remove' },
          // Not a note — but a pulled recording must still reach the
          // audio-memo reconciler, which subscribes to this same channel.
          {
            path: 'audio-memos/audio-memo-2026-06-11-090000-000.m4a',
            kind: 'upsert',
            modifiedMs: 456,
          },
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
      { path: 'audio-memos/audio-memo-2026-06-11-090000-000.m4a', kind: 'upsert', modifiedMs: 456 },
    ])
    controller.dispose()
    unlisten()
  })

  it('fans retry-merge batches immediately while serializing direct indexing', async () => {
    const firstChange: FileChange = {
      path: 'notes/from-remote-1.md',
      kind: 'upsert',
      modifiedMs: 123,
    }
    const secondChange: FileChange = {
      path: 'notes/from-remote-2.md',
      kind: 'upsert',
      modifiedMs: 456,
    }
    const { calls, releaseIndexApply } = fakeBridge({
      gateIndexApply: true,
      mergeOutcomes: [
        { kind: 'merged', conflictedPaths: [], changedFiles: [firstChange] },
        { kind: 'merged', conflictedPaths: [], changedFiles: [secondChange] },
      ],
      pushOutcomes: [
        { pushed: false, nonFastForward: true, rejectionMessage: 'fetch first' },
        { pushed: true, nonFastForward: false, rejectionMessage: null },
      ],
    })
    const batches: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => batches.push(changes))
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    try {
      await vi.waitFor(() => {
        expect(calls.filter((command) => command === 'git_push')).toHaveLength(2)
        expect(batches).toEqual([[firstChange], [secondChange]])
      })
      // The second callback already fanned out synchronously, but its direct
      // index write is queued behind the first gated batch.
      expect(calls.filter((command) => command === 'index_apply_batch')).toHaveLength(1)
      expect(controller.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'syncing' },
      })

      releaseIndexApply()
      await vi.waitFor(() => {
        expect(calls.filter((command) => command === 'index_apply_batch')).toHaveLength(2)
        expect(controller.getState()).toMatchObject({
          phase: 'connected',
          status: { state: 'idle' },
        })
      })
    } finally {
      controller.dispose()
      unlisten()
    }
  })

  it('does not start queued direct indexing after controller teardown', async () => {
    const { calls, releaseIndexApply } = fakeBridge({
      gateIndexApply: true,
      mergeOutcomes: [
        {
          kind: 'merged',
          conflictedPaths: [],
          changedFiles: [
            { path: 'notes/from-remote-1.md', kind: 'upsert', modifiedMs: 123 },
          ],
        },
        {
          kind: 'merged',
          conflictedPaths: [],
          changedFiles: [
            { path: 'notes/from-remote-2.md', kind: 'upsert', modifiedMs: 456 },
          ],
        },
      ],
      pushOutcomes: [
        { pushed: false, nonFastForward: true, rejectionMessage: 'fetch first' },
        { pushed: true, nonFastForward: false, rejectionMessage: null },
      ],
    })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'git_push')).toHaveLength(2)
      expect(calls.filter((command) => command === 'index_apply_batch')).toHaveLength(1)
    })

    controller.dispose()
    releaseIndexApply()
    // The first, already-running apply can finish. The second task then reaches
    // the controller-owned tail, observes the teardown epoch, and must exit
    // before touching the index bridge.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls.filter((command) => command === 'index_apply_batch')).toHaveLength(1)
  })

  it('keeps launch sync active until pulled notes finish direct indexing', async () => {
    const { calls, releaseIndexApply } = fakeBridge({
      gateIndexApply: true,
      mergeOutcome: {
        kind: 'fastForward',
        conflictedPaths: [],
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 123 }],
      },
    })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    await vi.waitFor(() => {
      expect(calls).toContain('index_apply_batch')
    })
    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      status: { state: 'syncing' },
    })

    releaseIndexApply()
    await vi.waitFor(() => {
      expect(controller.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'idle' },
      })
    })
    controller.dispose()
  })

  it('still settles to idle when direct indexing fails — projection health never blocks backup', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { calls } = fakeBridge({
      failIndexApply: true,
      mergeOutcome: {
        kind: 'fastForward',
        conflictedPaths: [],
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 123 }],
      },
    })
    const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
    await controller.start()

    await vi.waitFor(() => {
      expect(controller.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'idle' },
      })
    })
    expect(calls).toContain('index_apply_batch')
    // The failure is reported (which layer logs it is incidental), never thrown
    // into the sync cycle — the projection is rebuildable, the push is not.
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
    controller.dispose()
  })

  it('defers a pulled note direct-index apply while the mobile app is hidden', async () => {
    setPlatformSurface({ mobileApp: true })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const { calls } = fakeBridge({
        mergeOutcome: {
          kind: 'merged',
          conflictedPaths: [],
          changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 123 }],
        },
      })
      const controller = createBackupController({ graph: GRAPH, indexGeneration: 1 })
      await controller.start()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(calls).not.toContain('note_read')
      expect(calls).not.toContain('index_apply_batch')
      controller.dispose()
    } finally {
      visibility.mockRestore()
      setPlatformSurface({ mobileApp: false })
    }
  })
})
