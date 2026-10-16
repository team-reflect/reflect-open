import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestGitRepositoryService, type TestGitRepositoryService } from '../testing/sync.ts'
import {
  createSyncEngineFactory,
  isSyncError,
  type SyncEngine,
  type SyncEngineOptions,
  type SyncStatus,
} from './engine.ts'
import type {
  CommitOutcome,
  PullOutcome,
  PushOutcome,
  RemoteDelta,
} from './git-repository-service.ts'

let clock: TestClockService
let activeGit: TestGitRepositoryService

beforeEach(() => {
  clock = createTestClockService()
  activeGit = createTestGitRepositoryService()
})

/**
 * An engine over the git fake of the last {@link fakeGit} call and the test clock.
 */
function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  return createSyncEngineFactory({ git: activeGit, clock }).create(options)
}

/**
 * Let every promise chain that is already runnable settle. The git fake
 * resolves on microtasks only, so draining microtask turns is deterministic.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    await Promise.resolve()
  }
}

/**
 * Move the clock by `ms`, running the timers that come due, then settle.
 */
async function advance(ms: number): Promise<void> {
  await clock.advance(ms)
  await flush()
}

/**
 * Run every scheduled timer, however far away, then settle.
 */
async function runAllTimers(): Promise<void> {
  await flush()
  while (clock.pendingTimers() > 0) {
    await clock.advance(60_000)
    await flush()
  }
}

const CRED = { username: 'x-access-token', secret: 'tok' }
const CLEAN_COMMIT: CommitOutcome = {
  committed: false,
  sha: null,
  ahead: 0,
  skippedLargeFiles: [],
}
const COMMITTED: CommitOutcome = {
  committed: true,
  sha: 'abc',
  ahead: 1,
  skippedLargeFiles: [],
}
const PUSHED: PushOutcome = { pushed: true, nonFastForward: false, rejectionMessage: null }
const NON_FAST_FORWARD: PushOutcome = {
  pushed: false,
  nonFastForward: true,
  rejectionMessage: 'fetch first',
}
const PULLED: PullOutcome = {
  committed: true,
  ahead: 1,
  skippedLargeFiles: [],
  reviewPaths: [],
  changedFiles: [],
}
const DELTA = { ahead: 1, behind: 0 }

/**
 * A git fake that commits, fetches, pulls, and pushes; every call recorded.
 */
function fakeGit(): TestGitRepositoryService {
  const git = createTestGitRepositoryService()
  git.onCommitAll(() => COMMITTED)
  git.onFetch(() => DELTA)
  git.onPull(() => PULLED)
  activeGit = git
  return git
}

function methodsOf(git: TestGitRepositoryService): string[] {
  return git.calls().map((call) => call.method)
}

describe('createSyncEngineFactory', () => {
  it('debounces edits into one commit→push cycle pinned to the generation', async () => {
    const git = fakeGit()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 7,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 100,
      maxWaitMs: 1000,
    })

    engine.noteChanged()
    engine.noteChanged() // coalesces into the same cycle
    await advance(99)
    expect(git.calls()).toHaveLength(0)
    await advance(1)
    await runAllTimers()

    expect(git.calls()).toEqual([
      { method: 'commitAll', args: ['Update notes', 7] },
      { method: 'push', args: [CRED, 7] },
    ])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('keeps deferring while edits continue, but never past maxWaitMs', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
      idleMs: 100,
      maxWaitMs: 250,
    })

    engine.noteChanged()
    await advance(80)
    engine.noteChanged()
    await advance(80)
    engine.noteChanged()
    expect(git.calls()).toHaveLength(0)
    await advance(100)
    await runAllTimers()
    expect(methodsOf(git)).toContain('commitAll')
    engine.stop()
  })

  it('recovers from a non-fast-forward push by fetch+merge+retry', async () => {
    let pushes = 0
    const git = fakeGit()
    git.onPush(() => {
      pushes += 1
      return pushes === 1 ? NON_FAST_FORWARD : PUSHED
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'push', 'fetch', 'pull', 'push'])
    expect(statuses.at(-1)?.state).toBe('idle')
    engine.stop()
  })

  it('maps a thrown ReflectError from token refresh to offline / auth states', async () => {
    const { ReflectError } = await import('../errors.ts')
    for (const [kind, expected] of [
      ['network', { state: 'offline' }],
      ['auth', { state: 'error', errorKind: 'auth' }],
    ] as const) {
      fakeGit()
      const statuses: SyncStatus[] = []
      const engine = createSyncEngine({
        generation: 1,
        getCredential: async () => {
          throw new ReflectError(kind, 'refresh failed')
        },
        onStatus: (status) => {
          statuses.push(status)
        },
        idleMs: 10,
      })
      engine.noteChanged()
      await runAllTimers()
      expect(statuses.at(-1)).toMatchObject(expected)
      engine.stop()
    }
  })

  it('maps a network failure to the offline state', async () => {
    const git = fakeGit()
    git.onPush(() => {
      throw { kind: 'network', message: 'could not resolve github.com' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(statuses.at(-1)?.state).toBe('offline')
    engine.stop()
  })

  it('maps an auth failure to an auth error state', async () => {
    const git = fakeGit()
    git.onPush(() => {
      throw { kind: 'auth', message: 'token rejected' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('commitNow joins the single-flight queue and never touches the network', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onPull(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(PULLED)
      })
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    try {
      const full = engine.syncNow()
      await vi.waitFor(() => expect(methodsOf(git)).toContain('pull'))
      const flushed = engine.commitNow()
      await Promise.resolve()
      // The pull is mid-merge: the flush commit waits instead of interleaving.
      expect(methodsOf(git)).not.toContain('commitAll')

      gate.release()
      await full
      await flushed
      const commands = methodsOf(git)
      expect(commands.filter((method) => method === 'commitAll')).toHaveLength(1)
      expect(commands.lastIndexOf('commitAll')).toBeGreaterThan(commands.indexOf('push'))
    } finally {
      gate.release()
      engine.stop()
    }
  })

  it('a push-only cycle hidden after its commit pushes', async () => {
    let canStartCycle = true
    const git = fakeGit()
    git.onCommitAll(() => {
      canStartCycle = false
      return COMMITTED
    })
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => canStartCycle,
      idleMs: 100,
    })
    engine.noteChanged()
    await advance(100)
    await runAllTimers()
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])
    engine.stop()
  })

  it('a flush queued behind a sync commits when the app hides meanwhile', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onPull(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(PULLED)
      })
    })
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => canStartCycle,
    })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(methodsOf(git)).toContain('pull'))
    const second = engine.syncNow()
    canStartCycle = false
    const flushed = engine.commitNow()
    gate.release()
    await first
    await flushed
    await second
    const commands = methodsOf(git)
    expect(commands.filter((method) => method === 'push')).toHaveLength(0)
    expect(commands.filter((method) => method === 'commitAll')).toHaveLength(1)
    expect(commands.lastIndexOf('commitAll')).toBeGreaterThan(commands.indexOf('pull'))
    engine.stop()
  })

  it('a flush queued into a full cycle commits when the gate closes after the fetch', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onPull(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(PULLED)
      })
    })
    let canStartCycle = true
    let fetches = 0
    git.onFetch(() => {
      fetches += 1
      if (fetches === 2) {
        canStartCycle = false
      }
      return DELTA
    })
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => canStartCycle,
    })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(methodsOf(git)).toContain('pull'))
    const second = engine.syncNow()
    const flushed = engine.commitNow()
    gate.release()
    await first
    await flushed
    await second
    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push', 'fetch', 'commitAll'])
    engine.stop()
  })

  it('a full cycle fetches before it pulls, and never commits on its own', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })
    await engine.syncNow()
    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])
    engine.stop()
  })

  it('a failed fetch commits local changes', async () => {
    const git = fakeGit()
    git.onFetch(() => {
      throw { kind: 'network', message: 'could not resolve github.com' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
    })
    await engine.syncNow()
    expect(methodsOf(git)).toEqual(['fetch', 'commitAll'])
    expect(statuses.at(-1)?.state).toBe('offline')
    engine.stop()
  })

  it('pushes when the pull itself committed', async () => {
    const git = fakeGit()
    git.onPull(() => ({ ...PULLED, committed: true, ahead: 0 }))
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })
    await engine.syncNow()
    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])
    engine.stop()
  })

  it('requests queued behind a running cycle merge into one follow-up that does their union', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onPull(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(PULLED)
      })
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(methodsOf(git)).toContain('pull'))
    engine.noteChanged() // the debounce asks for a push
    await advance(10)
    const flushed = engine.commitNow() // the flush asks for a commit
    gate.release()
    await first
    await flushed
    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push', 'commitAll', 'push'])
    engine.stop()
  })

  it('commitNow runs even when the owner gates cycles (the hidden-app flush)', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => false,
    })
    await engine.commitNow()
    expect(methodsOf(git)).toEqual(['commitAll'])
    await engine.syncNow()
    expect(methodsOf(git)).toEqual(['commitAll']) // still gated
    engine.stop()
  })

  it('after an auth failure, edits commit locally and skip the network until a resume', async () => {
    let pushes = 0
    const git = fakeGit()
    git.onPush(() => {
      pushes += 1
      throw { kind: 'auth', message: 'token rejected' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    const emitted = statuses.length

    engine.noteChanged()
    await runAllTimers()
    expect(methodsOf(git).filter((method) => method === 'commitAll')).toHaveLength(2)
    expect(pushes).toBe(1)
    expect(statuses).toHaveLength(emitted) // the auth error stays on screen

    await engine.syncNow() // focus / online / manual: try the network again
    expect(pushes).toBe(2)
    engine.stop()
  })

  it('surfaces a non-divergence rejection (e.g. push protection) as an error', async () => {
    const git = fakeGit()
    git.onPush(() => {
      return {
        pushed: false,
        nonFastForward: false,
        rejectionMessage: 'GH013: secret detected in notes/keys.md',
      }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    const last = statuses.at(-1)
    if (last === undefined || !isSyncError(last)) {
      throw new Error(`expected an error status, got ${JSON.stringify(last)}`)
    }
    expect(last.errorKind).toBe('rejected')
    expect(last.message).toContain('GH013')
    engine.stop()
  })

  it('gives up after repeated non-fast-forward rounds instead of looping forever', async () => {
    const git = fakeGit()
    git.onPush(() => {
      return NON_FAST_FORWARD
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(git.calls().filter((call) => call.method === 'push')).toHaveLength(3)
    expect(statuses.at(-1)?.state).toBe('error')
    engine.stop()
  })

  it('preserves the full-cycle mode when syncNow lands mid-cycle', async () => {
    const pushGate: { resolve: ((value: PushOutcome) => void) | null } = { resolve: null }
    const git = fakeGit()
    git.onPush(() => {
      if (pushGate.resolve === null) {
        return new Promise((resolve) => {
          pushGate.resolve = resolve
        })
      }
      return PUSHED
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

    engine.noteChanged()
    await advance(10)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    void engine.syncNow()
    pushGate.resolve?.(PUSHED)
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'push', 'fetch', 'pull', 'push'])
    engine.stop()
  })

  it('hands merge-changed files to the reindex callback', async () => {
    const git = fakeGit()
    git.onPull(() => ({
      committed: true,
      ahead: 1,
      skippedLargeFiles: [],
      reviewPaths: [],
      changedFiles: [
        { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 1 },
        { path: 'notes/gone.md', kind: 'remove', modifiedMs: null },
      ],
    }))
    const batches: Array<Array<{ path: string }>> = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onRemoteChanges: (changes) => {
        batches.push(changes)
      },
    })

    await engine.syncNow()

    expect(batches).toEqual([
      [
        { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 1 },
        { path: 'notes/gone.md', kind: 'remove', modifiedMs: null },
      ],
    ])
    engine.stop()
  })

  it('continues through push while remote-change handling runs, then waits before idle', async () => {
    const git = fakeGit()
    git.onPull(() => ({
      ...PULLED,
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 1 }],
    }))
    const remoteChangesGate = Promise.withResolvers<void>()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () => remoteChangesGate.promise,
    })

    const syncing = engine.syncNow()
    await advance(0)

    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    remoteChangesGate.resolve()
    await syncing

    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('starts every remote-change callback immediately while repeated Git convergence continues', async () => {
    let mergeCount = 0
    let pushCount = 0
    const git = fakeGit()
    git.onPull(() => {
      mergeCount += 1
      return {
        ...PULLED,
        changedFiles: [{ path: `notes/remote-${mergeCount}.md`, kind: 'upsert', modifiedMs: 1 }],
      }
    })
    git.onPush(() => {
      pushCount += 1
      return pushCount === 1 ? NON_FAST_FORWARD : PUSHED
    })
    const firstBatchGate = Promise.withResolvers<void>()
    const started: string[] = []
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: (changes) => {
        started.push(changes[0]!.path)
        if (started.length === 1) {
          return firstBatchGate.promise
        }
      },
    })

    const syncing = engine.syncNow()
    await advance(0)

    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push', 'fetch', 'pull', 'push'])
    expect(started).toEqual(['notes/remote-1.md', 'notes/remote-2.md'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    firstBatchGate.resolve()
    await syncing

    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('finishes async remote-change handling before applying a suppression gate', async () => {
    const git = fakeGit()
    git.onPull(() => ({
      ...PULLED,
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 1 }],
    }))
    const remoteChangesGate = Promise.withResolvers<void>()
    const statuses: SyncStatus[] = []
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      canStartCycle: () => canStartCycle,
      onRemoteChanges: () => remoteChangesGate.promise,
    })

    const syncing = engine.syncNow()
    await advance(0)
    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])

    canStartCycle = false
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
    remoteChangesGate.resolve()
    await syncing

    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('surfaces an async remote-change failure only after the push finishes', async () => {
    const pushGate = Promise.withResolvers<PushOutcome>()
    const git = fakeGit()
    git.onPull(() => {
      return {
        ...PULLED,
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 1 }],
      }
    })
    git.onPush(() => {
      return pushGate.promise
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: async () => {
        throw new Error('remote index failed')
      },
    })

    const syncing = engine.syncNow()
    await advance(0)

    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    pushGate.resolve(PUSHED)
    await syncing

    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      errorKind: 'other',
      message: 'remote index failed',
    })
    engine.stop()
  })

  it('stop while merge is in flight never starts its remote-change callback', async () => {
    const mergeGate = Promise.withResolvers<PullOutcome>()
    const git = fakeGit()
    git.onPull(() => {
      return mergeGate.promise
    })
    const remoteChanges = vi.fn()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: remoteChanges,
    })

    const syncing = engine.syncNow()
    await advance(0)
    expect(methodsOf(git)).toEqual(['fetch', 'pull'])

    engine.stop()
    mergeGate.resolve({
      ...PULLED,
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 1 }],
    })
    await syncing

    expect(methodsOf(git)).toEqual(['fetch', 'pull'])
    expect(remoteChanges).not.toHaveBeenCalled()
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('stop after a remote-change task starts emits no later status or Git work', async () => {
    const git = fakeGit()
    git.onPull(() => ({
      ...PULLED,
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 1 }],
    }))
    const remoteChangesGate = Promise.withResolvers<void>()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () => remoteChangesGate.promise,
    })

    const syncing = engine.syncNow()
    await advance(0)
    const commandsBeforeStop = methodsOf(git)
    expect(commandsBeforeStop).toEqual(['fetch', 'pull', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    engine.stop()
    remoteChangesGate.resolve()
    await syncing

    expect(methodsOf(git)).toEqual(commandsBeforeStop)
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('stop from a synchronous remote-change callback prevents the later push', async () => {
    const git = fakeGit()
    git.onPull(() => ({
      ...PULLED,
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 1 }],
    }))
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () => engine.stop(),
    })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['fetch', 'pull'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('reports files withheld by the size guardrail', async () => {
    const git = fakeGit()
    git.onCommitAll(() => ({
      committed: true,
      sha: 'abc',
      ahead: 1,
      skippedLargeFiles: [{ path: 'assets/movie.mp4', size: 200_000_000 }],
      changedFiles: [],
      reviewPaths: [],
    }))
    const skipped: Array<{ path: string }[]> = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onLargeFilesSkipped: (files) => {
        skipped.push(files)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(skipped).toEqual([[{ path: 'assets/movie.mp4', size: 200_000_000 }]])
    engine.stop()
  })

  it('runs one cycle at a time and schedules a follow-up for mid-cycle edits', async () => {
    const pushGate: { resolve: ((value: PushOutcome) => void) | null } = { resolve: null }
    const git = fakeGit()
    git.onPush(() => {
      return new Promise((resolve) => {
        pushGate.resolve = resolve
      })
    })
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      idleMs: 10,
    })

    engine.noteChanged()
    await advance(10)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    engine.noteChanged() // lands mid-cycle: must not start a second commit
    await advance(50)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    pushGate.resolve?.(PUSHED)
    await runAllTimers()
    expect(methodsOf(git)).toEqual(['commitAll', 'push', 'commitAll', 'push'])
    engine.stop()
  })

  it('skips the push when a debounced pass finds nothing committed and nothing ahead', async () => {
    const git = fakeGit()
    git.onCommitAll(() => CLEAN_COMMIT)
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

    engine.noteChanged()
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll'])
    engine.stop()
  })

  it('skips the push when a launch pull finds both sides already in step', async () => {
    const git = fakeGit()
    git.onPull(() => ({ ...PULLED, committed: false, ahead: 0 }))
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['fetch', 'pull'])
    engine.stop()
  })

  it('a full sync cancels a pending debounced pass instead of double-running', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      idleMs: 100,
    })

    engine.noteChanged() // schedules a debounced pass…
    await engine.syncNow() // …which this full cycle already covers
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])
    engine.stop()
  })

  it('localOnly commits and never touches the network — even for a full sync', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
      localOnly: true,
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()
    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])
    engine.stop()
  })

  it('stop() cancels pending work', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

    engine.noteChanged()
    engine.stop()
    await runAllTimers()

    expect(git.calls()).toHaveLength(0)
  })

  it('passes a missing credential through as null (Rust owns the failure)', async () => {
    const git = fakeGit()
    git.onPush(() => {
      throw { kind: 'auth', message: 'authentication required' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    const push = git.calls().find((call) => call.method === 'push')
    expect(push?.args[0]).toBeNull()
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('ignores edits arriving after stop() — the abort is sticky', async () => {
    const git = fakeGit()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.stop()
    engine.noteChanged()
    await engine.syncNow()
    await runAllTimers()

    expect(git.calls()).toHaveLength(0)
    expect(statuses).toHaveLength(0)
  })

  it('serializes concurrent syncNow calls into one cycle plus one follow-up', async () => {
    const pushGates: Array<(value: PushOutcome) => void> = []
    const git = fakeGit()
    git.onPush(() => {
      return new Promise((resolve) => {
        pushGates.push(resolve)
      })
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    const first = engine.syncNow()
    const second = engine.syncNow()
    const third = engine.syncNow()
    await runAllTimers()
    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push'])

    pushGates.shift()?.(PUSHED)
    await runAllTimers()
    pushGates.shift()?.(PUSHED)
    await runAllTimers()
    await Promise.all([first, second, third])

    expect(methodsOf(git)).toEqual(['fetch', 'pull', 'push', 'fetch', 'pull', 'push'])
    engine.stop()
  })

  it('stops at the next command boundary when cycles become suppressed', async () => {
    let canStartCycle = true
    const fetchGate = Promise.withResolvers<RemoteDelta>()
    const git = fakeGit()
    git.onFetch(() => {
      return fetchGate.promise
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      canStartCycle: () => canStartCycle,
    })

    const syncing = engine.syncNow()
    await advance(0)
    expect(methodsOf(git)).toEqual(['fetch'])

    canStartCycle = false
    fetchGate.resolve(DELTA)
    await syncing

    expect(methodsOf(git)).toEqual(['fetch'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('stop() mid-cycle issues no further commands and emits no further status', async () => {
    const pushGate = Promise.withResolvers<PushOutcome>()
    const git = fakeGit()
    git.onPush(() => {
      return pushGate.promise
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await advance(10)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    engine.stop()
    pushGate.resolve(NON_FAST_FORWARD)
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })
})

describe('quiet mode', () => {
  const QUIET_MS = 1000

  function quietEngine(
    extra: Partial<SyncEngineOptions> = {},
    statuses: SyncStatus[] = [],
  ): SyncEngine {
    return createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 100,
      quietMs: QUIET_MS,
      ...extra,
    })
  }

  it('an edit commits after the debounce and fetches only after the quiet window', async () => {
    const git = fakeGit()
    const engine = quietEngine()

    engine.noteChanged()
    await advance(100)
    expect(methodsOf(git)).toEqual(['commitAll'])
    await advance(QUIET_MS - 1)
    expect(methodsOf(git)).toEqual(['commitAll'])
    await advance(1)
    await vi.waitFor(() => {
      expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'pull', 'push'])
    })
    engine.stop()
  })

  it('every edit and every pull restarts the window', async () => {
    const git = fakeGit()
    const engine = quietEngine()

    engine.noteChanged()
    await advance(100) // window ends at 1100
    await advance(500)
    engine.noteChanged()
    await advance(100) // second commit; window now ends at 1700
    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])
    await advance(QUIET_MS - 1)
    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])
    git.onPull(() => ({
      ...PULLED,
      changedFiles: [{ path: 'a.md', kind: 'upsert', modifiedMs: 1 }],
    }))
    await advance(1)
    await vi.waitFor(() => {
      expect(methodsOf(git)).toContain('pull')
    })
    await advance(0)

    // The pull restarted the window: the next network pass is a full window away.
    const fetches = (): number => methodsOf(git).filter((method) => method === 'fetch').length
    expect(fetches()).toBe(1)
    await advance(QUIET_MS - 1)
    expect(fetches()).toBe(1)
    await advance(1)
    await vi.waitFor(() => {
      expect(fetches()).toBe(2)
    })
    engine.stop()
  })

  it('syncNow commits now and does not fetch', async () => {
    const git = fakeGit()
    const engine = quietEngine()

    await engine.syncNow()
    expect(methodsOf(git)).toEqual(['commitAll'])
    await advance(QUIET_MS / 2)
    await engine.syncNow() // the open window stays where it was
    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])
    await advance(QUIET_MS / 2 - 1)
    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])
    await advance(1)
    await vi.waitFor(() => {
      expect(methodsOf(git)).toContain('fetch')
    })
    engine.stop()
  })

  it('a quiet window after an auth failure skips the network until a resume', async () => {
    let pushes = 0
    const git = fakeGit()
    git.onPush(() => {
      pushes += 1
      throw { kind: 'auth', message: 'token rejected' }
    })
    const engine = quietEngine()

    engine.noteChanged()
    await advance(100)
    await advance(QUIET_MS)
    await vi.waitFor(() => expect(pushes).toBe(1))

    engine.noteChanged()
    await advance(100)
    await advance(QUIET_MS)
    await runAllTimers()
    expect(pushes).toBe(1)
    expect(methodsOf(git).filter((method) => method === 'fetch')).toHaveLength(1)
    engine.stop()
  })

  it('focusing the window every minute does not postpone the backup', async () => {
    const git = fakeGit()
    const engine = quietEngine({ quietMs: 5 * 60_000 })

    await engine.syncNow()
    for (let minute = 1; minute < 5; minute++) {
      await advance(60_000)
      await engine.syncNow()
    }
    expect(methodsOf(git)).not.toContain('fetch')
    await advance(60_000)
    await vi.waitFor(() => {
      expect(methodsOf(git)).toContain('fetch')
    })
    engine.stop()
  })

  it('syncNow during a back-off keeps the back-off', async () => {
    const git = fakeGit()
    const asks: number[] = []
    const engine = quietEngine({
      networkReady: async () => {
        asks.push(clock.now())
        return false
      },
    })

    await engine.syncNow()
    await advance(QUIET_MS)
    await advance(30_000)
    await engine.syncNow()
    await advance(60_000)
    expect(asks).toEqual([1000, 31_000, 91_000])
    expect(methodsOf(git)).not.toContain('fetch')
    engine.stop()
  })

  it('networkReady false backs off up to five minutes', async () => {
    const git = fakeGit()
    const asks: number[] = []
    let ready = false
    const engine = quietEngine({
      networkReady: async () => {
        asks.push(clock.now())
        return ready
      },
    })

    await engine.syncNow()
    await advance(QUIET_MS)
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      await advance(delay)
    }
    expect(asks).toEqual([1000, 31_000, 91_000, 211_000, 451_000, 751_000, 1_051_000])
    expect(methodsOf(git)).toEqual(['commitAll'])

    ready = true
    await advance(300_000)
    await vi.waitFor(() => {
      expect(methodsOf(git)).toContain('fetch')
    })
    engine.stop()
  })

  it('an edit during the readiness ask is honoured', async () => {
    const git = fakeGit()
    let answer: (ready: boolean) => void = () => {}
    let asks = 0
    const engine = quietEngine({
      networkReady: () => {
        asks += 1
        return new Promise<boolean>((resolve) => {
          answer = resolve
        })
      },
    })

    await engine.syncNow()
    await advance(QUIET_MS)
    expect(asks).toBe(1)
    engine.noteChanged() // an edit while the ask is open: a fresh window
    await advance(100)
    answer(true)
    await flush()
    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])

    await advance(QUIET_MS)
    expect(asks).toBe(2)
    answer(true)
    await vi.waitFor(() => {
      expect(methodsOf(git)).toContain('fetch')
    })
    engine.stop()
  })

  it('an edit just before the window ends moves the network pass to a new window', async () => {
    const git = fakeGit()
    const engine = quietEngine({ quietMs: 5 * 60_000, idleMs: 30_000 })

    await engine.syncNow() // window ends at 300 s
    await advance(299_000)
    engine.noteChanged() // commit due at 329 s, which opens a window ending at 629 s
    await advance(1000) // the old expiry
    expect(methodsOf(git)).toEqual(['commitAll'])
    await advance(30_000)
    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])
    await advance(299_000 - 1) // 1 ms before the new expiry
    expect(methodsOf(git)).not.toContain('fetch')
    await advance(1)
    await vi.waitFor(() => {
      expect(methodsOf(git)).toEqual(['commitAll', 'commitAll', 'fetch', 'pull', 'push'])
    })
    engine.stop()
  })

  it('a waiting status is emitted with the window end', async () => {
    fakeGit()
    const statuses: SyncStatus[] = []
    const engine = quietEngine({}, statuses)

    await clock.advance(400)
    await engine.syncNow()
    expect(statuses).toEqual([
      { state: 'waiting', until: 1400 },
      { state: 'syncing' },
      { state: 'waiting', until: 1400 },
    ])
    engine.stop()
  })
})

describe('review paths', () => {
  it('reports the review paths of a merge', async () => {
    const git = fakeGit()
    git.onPull(() => ({
      committed: false,
      ahead: 0,
      skippedLargeFiles: [],
      reviewPaths: ['a.png'],
      changedFiles: [],
    }))
    const reviews: string[][] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onReview: (paths) => {
        reviews.push(paths)
      },
    })

    await engine.syncNow()
    expect(reviews).toEqual([['a.png']])
    engine.stop()
  })
})
