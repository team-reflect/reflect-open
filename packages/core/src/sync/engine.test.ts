import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { createSyncEngine, isSyncError, type SyncStatus } from './engine'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  setBridge(null)
})

const CLEAN_COMMIT = { committed: false, sha: null, ahead: 0, skippedLargeFiles: [] }
const COMMITTED = { committed: true, sha: 'abc', ahead: 1, skippedLargeFiles: [] }
const PUSHED = { pushed: true, nonFastForward: false, rejectionMessage: null }
const NON_FAST_FORWARD = {
  pushed: false,
  nonFastForward: true,
  rejectionMessage: 'fetch first',
}
const MERGED = { kind: 'merged', conflictedPaths: [], changedFiles: [] }
const DELTA = { ahead: 1, behind: 0 }

interface Call {
  command: string
  args: Record<string, unknown>
}

/** Bridge fake: scripted responses per command, every call recorded. */
function fakeGit(respond: (command: string, calls: Call[]) => unknown) {
  const calls: Call[] = []
  setBridge({
    invoke: async (command, args) => {
      calls.push({ command, args })
      return respond(command, calls)
    },
    listen: async () => () => {},
  })
  return calls
}

function defaultResponses(command: string): unknown {
  switch (command) {
    case 'git_commit_all':
      return COMMITTED
    case 'git_push':
      return PUSHED
    case 'git_fetch':
      return DELTA
    case 'git_merge_remote':
      return MERGED
    default:
      return null
  }
}

function commandsOf(calls: Call[]): string[] {
  return calls.map((call) => call.command)
}

describe('createSyncEngine', () => {
  it('debounces edits into one commit→push cycle pinned to the generation', async () => {
    const calls = fakeGit(defaultResponses)
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 7,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 100,
      maxWaitMs: 1000,
    })

    engine.noteChanged()
    engine.noteChanged() // coalesces into the same cycle
    await vi.advanceTimersByTimeAsync(99)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()

    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_push'])
    expect(calls[0].args.generation).toBe(7)
    expect(calls[1].args.token).toBe('tok')
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('keeps deferring while edits continue, but never past maxWaitMs', async () => {
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => null,
      idleMs: 100,
      maxWaitMs: 250,
    })

    // An edit every 80ms keeps resetting the idle window…
    engine.noteChanged()
    await vi.advanceTimersByTimeAsync(80)
    engine.noteChanged()
    await vi.advanceTimersByTimeAsync(80)
    engine.noteChanged()
    expect(calls).toHaveLength(0)
    // …but the 250ms ceiling forces the cycle anyway.
    await vi.advanceTimersByTimeAsync(100)
    await vi.runAllTimersAsync()
    expect(commandsOf(calls)).toContain('git_commit_all')
    engine.stop()
  })

  it('recovers from a non-fast-forward push by fetch+merge+retry', async () => {
    let pushes = 0
    const calls = fakeGit((command) => {
      if (command === 'git_push') {
        pushes += 1
        return pushes === 1 ? NON_FAST_FORWARD : PUSHED
      }
      return defaultResponses(command)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_push',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    expect(statuses.at(-1)?.state).toBe('idle')
    engine.stop()
  })

  it('maps a thrown ReflectError from token refresh to offline / auth states', async () => {
    // getGithubToken throws ReflectError (an Error subclass) for transient
    // refresh failures — the engine must read it like any AppError, or the
    // offline/auth UX silently degrades to a generic error.
    const { ReflectError } = await import('../errors')
    for (const [kind, expected] of [
      ['network', { state: 'offline' }],
      ['auth', { state: 'error', errorKind: 'auth' }],
    ] as const) {
      fakeGit(defaultResponses)
      const statuses: SyncStatus[] = []
      const engine = createSyncEngine({
        generation: 1,
        getToken: async () => {
          throw new ReflectError(kind, 'refresh failed')
        },
        onStatus: (status) => statuses.push(status),
        idleMs: 10,
      })
      engine.noteChanged()
      await vi.runAllTimersAsync()
      expect(statuses.at(-1)).toMatchObject(expected)
      engine.stop()
    }
  })

  it('maps a network failure to the offline state', async () => {
    fakeGit((command) => {
      if (command === 'git_push') {
        throw { kind: 'network', message: 'could not resolve github.com' }
      }
      return defaultResponses(command)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    expect(statuses.at(-1)?.state).toBe('offline')
    engine.stop()
  })

  it('maps an auth failure to an auth error state', async () => {
    fakeGit((command) => {
      if (command === 'git_push') {
        throw { kind: 'auth', message: 'token rejected' }
      }
      return defaultResponses(command)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('surfaces a non-divergence rejection (e.g. push protection) as an error', async () => {
    fakeGit((command) => {
      if (command === 'git_push') {
        return {
          pushed: false,
          nonFastForward: false,
          rejectionMessage: 'GH013: secret detected in notes/keys.md',
        }
      }
      return defaultResponses(command)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    const last = statuses.at(-1)
    if (last === undefined || !isSyncError(last)) {
      throw new Error(`expected an error status, got ${JSON.stringify(last)}`)
    }
    expect(last.errorKind).toBe('rejected')
    expect(last.message).toContain('GH013')
    engine.stop()
  })

  it('gives up after repeated non-fast-forward rounds instead of looping forever', async () => {
    const calls = fakeGit((command) => {
      if (command === 'git_push') {
        return NON_FAST_FORWARD
      }
      return defaultResponses(command)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    expect(calls.filter((call) => call.command === 'git_push')).toHaveLength(3)
    expect(statuses.at(-1)?.state).toBe('error')
    engine.stop()
  })

  it('preserves the full-cycle mode when syncNow lands mid-cycle', async () => {
    const pushGate: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const calls = fakeGit((command) => {
      if (command === 'git_push' && pushGate.resolve === null) {
        return new Promise((resolve) => {
          pushGate.resolve = resolve
        })
      }
      return defaultResponses(command)
    })
    const engine = createSyncEngine({ generation: 1, getToken: async () => 'tok', idleMs: 10 })

    engine.noteChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_push'])

    // A focus/manual sync arrives mid-cycle: its fetch+merge must not be
    // downgraded to a push-only follow-up.
    void engine.syncNow()
    pushGate.resolve?.(PUSHED)
    await vi.runAllTimersAsync()

    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_push',
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    engine.stop()
  })

  it('hands merge-changed files to the reindex callback', async () => {
    fakeGit((command) =>
      command === 'git_merge_remote'
        ? {
            kind: 'merged',
            conflictedPaths: [],
            changedFiles: [
              { path: 'notes/from-b.md', kind: 'upsert' },
              { path: 'notes/gone.md', kind: 'remove' },
            ],
          }
        : defaultResponses(command),
    )
    const batches: Array<Array<{ path: string }>> = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onRemoteChanges: (changes) => batches.push(changes),
    })

    await engine.syncNow()

    expect(batches).toEqual([
      [
        { path: 'notes/from-b.md', kind: 'upsert' },
        { path: 'notes/gone.md', kind: 'remove' },
      ],
    ])
    engine.stop()
  })

  it('syncNow pulls and merges even with nothing to push (launch/focus)', async () => {
    const calls = fakeGit((command) =>
      command === 'git_commit_all' ? CLEAN_COMMIT : defaultResponses(command),
    )
    const engine = createSyncEngine({ generation: 1, getToken: async () => 'tok' })

    await engine.syncNow()

    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    engine.stop()
  })

  it('reports files withheld by the size guardrail', async () => {
    fakeGit((command) =>
      command === 'git_commit_all'
        ? {
            committed: true,
            sha: 'abc',
            ahead: 1,
            skippedLargeFiles: [{ path: 'assets/movie.mp4', size: 200_000_000 }],
          }
        : defaultResponses(command),
    )
    const skipped: Array<{ path: string }[]> = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onLargeFilesSkipped: (files) => skipped.push(files),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    expect(skipped).toEqual([[{ path: 'assets/movie.mp4', size: 200_000_000 }]])
    engine.stop()
  })

  it('runs one cycle at a time and schedules a follow-up for mid-cycle edits', async () => {
    const pushGate: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const calls = fakeGit((command) => {
      if (command === 'git_push') {
        return new Promise((resolve) => {
          pushGate.resolve = resolve
        })
      }
      return defaultResponses(command)
    })
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_push'])

    engine.noteChanged() // lands mid-cycle: must not start a second commit
    await vi.advanceTimersByTimeAsync(50)
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_push'])

    pushGate.resolve?.(PUSHED)
    await vi.runAllTimersAsync()
    // The mid-cycle edit got its own follow-up cycle.
    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_push',
      'git_commit_all',
      'git_push',
    ])
    engine.stop()
  })

  it('skips the push when a debounced pass finds nothing committed and nothing ahead', async () => {
    // The watcher re-reports a pull's own writes; the resulting cycle must
    // not buy a network round-trip for them.
    const calls = fakeGit((command) =>
      command === 'git_commit_all' ? CLEAN_COMMIT : defaultResponses(command),
    )
    const engine = createSyncEngine({ generation: 1, getToken: async () => 'tok', idleMs: 10 })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    expect(commandsOf(calls)).toEqual(['git_commit_all'])
    engine.stop()
  })

  it('skips the push when a launch pull finds both sides already in step', async () => {
    const calls = fakeGit((command) => {
      if (command === 'git_commit_all') {
        return CLEAN_COMMIT
      }
      if (command === 'git_fetch') {
        return { ahead: 0, behind: 0 }
      }
      if (command === 'git_merge_remote') {
        return { kind: 'upToDate', conflictedPaths: [], changedFiles: [] }
      }
      return defaultResponses(command)
    })
    const engine = createSyncEngine({ generation: 1, getToken: async () => 'tok' })

    await engine.syncNow()

    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch', 'git_merge_remote'])
    engine.stop()
  })

  it('a full sync cancels a pending debounced pass instead of double-running', async () => {
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      idleMs: 100,
    })

    engine.noteChanged() // schedules a debounced pass…
    await engine.syncNow() // …which this full cycle already covers
    await vi.runAllTimersAsync()

    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    engine.stop()
  })

  it('stop() cancels pending work', async () => {
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({ generation: 1, getToken: async () => 'tok', idleMs: 10 })

    engine.noteChanged()
    engine.stop()
    await vi.runAllTimersAsync()

    expect(calls).toHaveLength(0)
  })

  it('passes a missing credential through as a null token (Rust owns the failure)', async () => {
    // The engine has no null-token special case on purpose: only the remote
    // knows whether it needs auth. A push refused for a missing credential
    // must still land on the reconnect affordance.
    const calls = fakeGit((command) => {
      if (command === 'git_push') {
        throw { kind: 'auth', message: 'authentication required' }
      }
      return defaultResponses(command)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => null,
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    const push = calls.find((call) => call.command === 'git_push')
    expect(push?.args.token).toBeNull()
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('ignores edits arriving after stop() — the abort is sticky', async () => {
    const calls = fakeGit(defaultResponses)
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.stop()
    engine.noteChanged()
    await engine.syncNow()
    await vi.runAllTimersAsync()

    expect(calls).toHaveLength(0)
    expect(statuses).toHaveLength(0)
  })

  it('serializes concurrent syncNow calls into one cycle plus one follow-up', async () => {
    const pushGates: Array<(value: unknown) => void> = []
    const calls = fakeGit((command) => {
      if (command === 'git_push') {
        return new Promise((resolve) => {
          pushGates.push(resolve)
        })
      }
      return defaultResponses(command)
    })
    const engine = createSyncEngine({ generation: 1, getToken: async () => 'tok' })

    const first = engine.syncNow()
    const second = engine.syncNow()
    const third = engine.syncNow()
    await vi.runAllTimersAsync()
    // Only the first cycle has started; the others coalesced, not interleaved.
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch', 'git_merge_remote', 'git_push'])

    pushGates.shift()?.(PUSHED)
    await vi.runAllTimersAsync()
    pushGates.shift()?.(PUSHED)
    await vi.runAllTimersAsync()
    await Promise.all([first, second, third])

    // The two queued requests collapsed into a single full follow-up cycle.
    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    engine.stop()
  })

  it('stop() mid-cycle issues no further commands and emits no further status', async () => {
    const pushGate: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const calls = fakeGit((command) => {
      if (command === 'git_push') {
        return new Promise((resolve) => {
          pushGate.resolve = resolve
        })
      }
      return defaultResponses(command)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getToken: async () => 'tok',
      onStatus: (status) => statuses.push(status),
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_push'])

    // Disconnect/teardown while the push is in flight: the resolution would
    // normally trigger fetch+merge+retry (non-fast-forward) and a status
    // emission — a stopped engine must do neither.
    engine.stop()
    pushGate.resolve?.(NON_FAST_FORWARD)
    await vi.runAllTimersAsync()

    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })
})
