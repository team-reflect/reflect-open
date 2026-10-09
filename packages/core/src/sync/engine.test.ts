import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { createSyncEngine, isSyncError, type SyncStatus } from './engine.ts'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  setBridge(null)
})

const CRED = { username: 'x-access-token', secret: 'tok' }
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
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
    expect(calls[0]!.args['generation']).toBe(7)
    expect(calls[1]!.args['credential']).toEqual(CRED)
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('keeps deferring while edits continue, but never past maxWaitMs', async () => {
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
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
    const { ReflectError } = await import('../errors.ts')
    for (const [kind, expected] of [
      ['network', { state: 'offline' }],
      ['auth', { state: 'error', errorKind: 'auth' }],
    ] as const) {
      fakeGit(defaultResponses)
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('commitNow joins the single-flight queue and never touches the network', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const calls = fakeGit((command) => {
      if (command === 'git_merge_remote') {
        return new Promise((resolve) => {
          gate.release = () => resolve(MERGED)
        })
      }
      return defaultResponses(command)
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    const full = engine.syncNow()
    await vi.waitFor(() => expect(commandsOf(calls)).toContain('git_merge_remote'))
    const flushed = engine.commitNow()
    await Promise.resolve()
    // The pull is mid-merge: the flush commit waits instead of interleaving.
    expect(commandsOf(calls).filter((command) => command === 'git_commit_all')).toHaveLength(1)

    gate.release()
    await full
    await flushed
    const commands = commandsOf(calls)
    expect(commands.filter((command) => command === 'git_commit_all')).toHaveLength(2)
    expect(commands.lastIndexOf('git_commit_all')).toBeGreaterThan(commands.indexOf('git_push'))
    engine.stop()
  })

  it('a flush queued behind a sync still commits when the app hides meanwhile', async () => {
    // Visible: a sync is mid-merge and another syncNow queues a full
    // follow-up. The app goes to the background and the flush joins that
    // follow-up. The gate must not swallow the commit the flush is owed.
    const gate: { release: () => void } = { release: () => {} }
    const calls = fakeGit((command) => {
      if (command === 'git_merge_remote') {
        return new Promise((resolve) => {
          gate.release = () => resolve(MERGED)
        })
      }
      return defaultResponses(command)
    })
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => canStartCycle,
    })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(commandsOf(calls)).toContain('git_merge_remote'))
    const second = engine.syncNow()
    canStartCycle = false
    const flushed = engine.commitNow()
    gate.release()
    await first
    await flushed
    await second
    const commands = commandsOf(calls)
    // The running sync stopped at the gate after its merge, and the queued
    // full follow-up ran as the commit the flush was owed: no push, two commits.
    expect(commands.filter((command) => command === 'git_push')).toHaveLength(0)
    expect(commands.filter((command) => command === 'git_commit_all')).toHaveLength(2)
    expect(commands.lastIndexOf('git_commit_all')).toBeGreaterThan(
      commands.indexOf('git_merge_remote'),
    )
    engine.stop()
  })

  it('a queued flush commits before the follow-up resolves its credential', async () => {
    // The follow-up starts visible, so it runs as a full sync; the app hides
    // while the credential is being resolved. The commit has already landed.
    const gate: { release: () => void } = { release: () => {} }
    const calls = fakeGit((command) => {
      if (command === 'git_merge_remote') {
        return new Promise((resolve) => {
          gate.release = () => resolve(MERGED)
        })
      }
      return defaultResponses(command)
    })
    const credentialGate: { release: () => void } = { release: () => {} }
    let credentials = 0
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => {
        credentials += 1
        if (credentials === 2) {
          await new Promise<void>((resolve) => {
            credentialGate.release = resolve
          })
        }
        return CRED
      },
      canStartCycle: () => canStartCycle,
    })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(commandsOf(calls)).toContain('git_merge_remote'))
    const second = engine.syncNow()
    const flushed = engine.commitNow()
    gate.release()
    await first
    // The follow-up is running: its commit landed before it asked for a credential.
    await vi.waitFor(() => expect(credentials).toBe(2))
    expect(commandsOf(calls).filter((command) => command === 'git_commit_all')).toHaveLength(2)
    canStartCycle = false
    credentialGate.release()
    await flushed
    await second
    expect(commandsOf(calls).filter((command) => command === 'git_push')).toHaveLength(1) // the first sync only
    engine.stop()
  })

  it('requests queued behind a running cycle merge into one follow-up that does their union', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const calls = fakeGit((command) => {
      if (command === 'git_merge_remote') {
        return new Promise((resolve) => {
          gate.release = () => resolve(MERGED)
        })
      }
      return defaultResponses(command)
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(commandsOf(calls)).toContain('git_merge_remote'))
    engine.noteChanged() // the debounce asks for a push
    await vi.advanceTimersByTimeAsync(10)
    const flushed = engine.commitNow() // the flush asks for a commit
    gate.release()
    await first
    await flushed
    // One follow-up: its commit, then the push the debounce asked for; no
    // fetch, because nobody asked to pull.
    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
      'git_commit_all',
      'git_push',
    ])
    engine.stop()
  })

  describe('quiet mode (an iCloud-hosted graph with a remote)', () => {
    const QUIET_MS = 5 * 60_000

    function quietEngine(overrides: { networkReady?: () => Promise<boolean> } = {}) {
      const calls = fakeGit(defaultResponses)
      const engine = createSyncEngine({
        generation: 1,
        getCredential: async () => CRED,
        idleMs: 10,
        quietMs: QUIET_MS,
        ...overrides,
      })
      return { calls, engine }
    }

    it('an edit commits after the debounce and the network waits for the quiet window', async () => {
      const { calls, engine } = quietEngine()
      engine.noteChanged()
      await vi.advanceTimersByTimeAsync(10)
      expect(commandsOf(calls)).toEqual(['git_commit_all'])

      await vi.advanceTimersByTimeAsync(QUIET_MS - 20)
      expect(commandsOf(calls)).toEqual(['git_commit_all'])

      await vi.advanceTimersByTimeAsync(20)
      expect(commandsOf(calls)).toEqual([
        'git_commit_all',
        'git_commit_all',
        'git_fetch',
        'git_merge_remote',
        'git_push',
      ])
      engine.stop()
    })

    it('every edit restarts the window', async () => {
      const { calls, engine } = quietEngine()
      engine.noteChanged()
      await vi.advanceTimersByTimeAsync(QUIET_MS / 2)
      engine.noteChanged()
      await vi.advanceTimersByTimeAsync(QUIET_MS / 2 + 10)
      expect(commandsOf(calls)).not.toContain('git_fetch')
      await vi.advanceTimersByTimeAsync(QUIET_MS / 2)
      expect(commandsOf(calls)).toContain('git_fetch')
      engine.stop()
    })

    it('syncNow commits at once and defers the network like an edit', async () => {
      const { calls, engine } = quietEngine()
      await engine.syncNow()
      expect(commandsOf(calls)).toEqual(['git_commit_all'])
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      expect(commandsOf(calls)).toContain('git_fetch')
      engine.stop()
    })

    it('a pull that changed files restarts the window', async () => {
      const calls = fakeGit((command) =>
        command === 'git_merge_remote'
          ? {
              kind: 'merged',
              conflictedPaths: [],
              changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
            }
          : defaultResponses(command),
      )
      const engine = createSyncEngine({
        generation: 1,
        getCredential: async () => CRED,
        idleMs: 10,
        quietMs: QUIET_MS,
        onRemoteChanges: () => {},
      })
      await engine.syncNow()
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      expect(commandsOf(calls).filter((command) => command === 'git_fetch')).toHaveLength(1)
      // The pull wrote files: another window, then another look at the remote.
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      expect(commandsOf(calls).filter((command) => command === 'git_fetch')).toHaveLength(2)
      engine.stop()
    })

    it('a provider that is still downloading is asked again thirty seconds later', async () => {
      let ready = false
      const { calls, engine } = quietEngine({ networkReady: async () => ready })
      engine.noteChanged()
      await vi.advanceTimersByTimeAsync(QUIET_MS + 10)
      expect(commandsOf(calls)).not.toContain('git_fetch')
      ready = true
      await vi.advanceTimersByTimeAsync(30_000)
      expect(commandsOf(calls)).toContain('git_fetch')
      engine.stop()
    })

    it('an edit while the provider is being asked restarts the window', async () => {
      let answer: (ready: boolean) => void = () => {}
      const networkReady = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          }),
      )
      const { calls, engine } = quietEngine({ networkReady })
      engine.noteChanged()
      await vi.advanceTimersByTimeAsync(QUIET_MS + 10)
      expect(networkReady).toHaveBeenCalledTimes(1)

      engine.noteChanged() // the walk is still running
      answer(true)
      await vi.advanceTimersByTimeAsync(QUIET_MS - 10)
      expect(commandsOf(calls)).not.toContain('git_fetch')
      await vi.advanceTimersByTimeAsync(20)
      expect(networkReady).toHaveBeenCalledTimes(2)
      engine.stop()
    })

    it('an edit during an unready answer leaves one timer, which stop() clears', async () => {
      let answer: (ready: boolean) => void = () => {}
      const networkReady = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          }),
      )
      const { calls, engine } = quietEngine({ networkReady })
      engine.noteChanged()
      await vi.advanceTimersByTimeAsync(QUIET_MS + 10)
      engine.noteChanged()
      answer(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(networkReady).toHaveBeenCalledTimes(1) // no thirty-second retry beside the window

      engine.stop()
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      expect(networkReady).toHaveBeenCalledTimes(1)
      expect(commandsOf(calls)).not.toContain('git_fetch')
    })

    it('a provider that stays unready is asked at doubling intervals', async () => {
      const networkReady = vi.fn(async () => false)
      const { engine } = quietEngine({ networkReady })
      engine.noteChanged()
      await vi.advanceTimersByTimeAsync(QUIET_MS + 10)
      expect(networkReady).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(networkReady).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(networkReady).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(networkReady).toHaveBeenCalledTimes(3)
      engine.stop()
    })
  })

  it('commitNow runs even when the owner gates cycles (the hidden-app flush)', async () => {
    // iOS fires the background flush after the document is hidden, exactly
    // when canStartCycle says no to network cycles.
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => false,
    })
    await engine.commitNow()
    expect(commandsOf(calls)).toEqual(['git_commit_all'])
    await engine.syncNow()
    expect(commandsOf(calls)).toEqual(['git_commit_all']) // still gated
    engine.stop()
  })

  it('after an auth failure, edits commit locally and skip the network until a resume', async () => {
    // A rejected sign-in (or an ssh agent with no key) does not fix itself
    // between keystrokes: per-edit retries would only repeat the error and
    // the reconnect prompt. Local history keeps accumulating meanwhile.
    let pushes = 0
    const calls = fakeGit((command) => {
      if (command === 'git_push') {
        pushes += 1
        throw { kind: 'auth', message: 'token rejected' }
      }
      return defaultResponses(command)
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
    await vi.runAllTimersAsync()
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    const emitted = statuses.length

    engine.noteChanged()
    await vi.runAllTimersAsync()
    expect(commandsOf(calls).filter((command) => command === 'git_commit_all')).toHaveLength(2)
    expect(pushes).toBe(1)
    expect(statuses).toHaveLength(emitted) // the auth error stays on screen

    await engine.syncNow() // focus / online / manual: try the network again
    expect(pushes).toBe(2)
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
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
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

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
      getCredential: async () => CRED,
      onRemoteChanges: (changes) => {
        batches.push(changes)
      },
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

  it('continues through push while remote-change handling runs, then waits before idle', async () => {
    const calls = fakeGit((command) =>
      command === 'git_merge_remote'
        ? {
            kind: 'merged',
            conflictedPaths: [],
            changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
          }
        : defaultResponses(command),
    )
    const remoteChangesGate: { resolve: (() => void) | null } = { resolve: null }
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () =>
        new Promise<void>((resolve) => {
          remoteChangesGate.resolve = resolve
        }),
    })

    const syncing = engine.syncNow()
    await vi.advanceTimersByTimeAsync(0)

    // The projection is still gated, but the merge's Markdown has already
    // continued through the durable Git push. Only the idle boundary waits.
    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    remoteChangesGate.resolve?.()
    await syncing

    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('starts every remote-change callback immediately while repeated Git convergence continues', async () => {
    let mergeCount = 0
    let pushCount = 0
    const calls = fakeGit((command) => {
      if (command === 'git_merge_remote') {
        mergeCount += 1
        return {
          kind: 'merged',
          conflictedPaths: [],
          changedFiles: [{ path: `notes/remote-${mergeCount}.md`, kind: 'upsert' }],
        }
      }
      if (command === 'git_push') {
        pushCount += 1
        return pushCount === 1 ? NON_FAST_FORWARD : PUSHED
      }
      return defaultResponses(command)
    })
    const firstBatchGate: { resolve: (() => void) | null } = { resolve: null }
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
          return new Promise<void>((resolve) => {
            firstBatchGate.resolve = resolve
          })
        }
      },
    })

    const syncing = engine.syncNow()
    await vi.advanceTimersByTimeAsync(0)

    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    // Both merges notify synchronously even though the first returned task is
    // still gated. Their async work can overlap; only idle waits for both.
    expect(started).toEqual(['notes/remote-1.md', 'notes/remote-2.md'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    firstBatchGate.resolve?.()
    await syncing

    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('finishes async remote-change handling before applying a suppression gate', async () => {
    const calls = fakeGit((command) =>
      command === 'git_merge_remote'
        ? {
            kind: 'merged',
            conflictedPaths: [],
            changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
          }
        : defaultResponses(command),
    )
    const remoteChangesGate: { resolve: (() => void) | null } = { resolve: null }
    const statuses: SyncStatus[] = []
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      canStartCycle: () => canStartCycle,
      onRemoteChanges: () =>
        new Promise<void>((resolve) => {
          remoteChangesGate.resolve = resolve
        }),
    })

    const syncing = engine.syncNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])

    canStartCycle = false
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
    remoteChangesGate.resolve?.()
    await syncing

    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('surfaces an async remote-change failure only after the push finishes', async () => {
    const pushGate: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const calls = fakeGit((command) => {
      if (command === 'git_merge_remote') {
        return {
          kind: 'merged',
          conflictedPaths: [],
          changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
        }
      }
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: async () => {
        throw new Error('remote index failed')
      },
    })

    const syncing = engine.syncNow()
    await vi.advanceTimersByTimeAsync(0)

    // The projection has already rejected, but that failure must not strand
    // the merged Markdown before its required push.
    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    pushGate.resolve?.(PUSHED)
    await syncing

    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      errorKind: 'other',
      message: 'remote index failed',
    })
    engine.stop()
  })

  it('stop while merge is in flight never starts its remote-change callback', async () => {
    const mergeGate: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const calls = fakeGit((command) => {
      if (command === 'git_merge_remote') {
        return new Promise((resolve) => {
          mergeGate.resolve = resolve
        })
      }
      return defaultResponses(command)
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
    await vi.advanceTimersByTimeAsync(0)
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch', 'git_merge_remote'])

    engine.stop()
    mergeGate.resolve?.({
      kind: 'merged',
      conflictedPaths: [],
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
    })
    await syncing

    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch', 'git_merge_remote'])
    expect(remoteChanges).not.toHaveBeenCalled()
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('stop after a remote-change task starts emits no later status or Git work', async () => {
    const calls = fakeGit((command) =>
      command === 'git_merge_remote'
        ? {
            kind: 'merged',
            conflictedPaths: [],
            changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
          }
        : defaultResponses(command),
    )
    const remoteChangesGate: { resolve: (() => void) | null } = { resolve: null }
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () =>
        new Promise<void>((resolve) => {
          remoteChangesGate.resolve = resolve
        }),
    })

    const syncing = engine.syncNow()
    await vi.advanceTimersByTimeAsync(0)
    const commandsBeforeStop = commandsOf(calls)
    expect(commandsBeforeStop).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    engine.stop()
    remoteChangesGate.resolve?.()
    await syncing

    expect(commandsOf(calls)).toEqual(commandsBeforeStop)
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('stop from a synchronous remote-change callback prevents the later push', async () => {
    const calls = fakeGit((command) =>
      command === 'git_merge_remote'
        ? {
            kind: 'merged',
            conflictedPaths: [],
            changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
          }
        : defaultResponses(command),
    )
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

    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch', 'git_merge_remote'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('syncNow pulls and merges even with nothing to push (launch/focus)', async () => {
    const calls = fakeGit((command) =>
      command === 'git_commit_all' ? CLEAN_COMMIT : defaultResponses(command),
    )
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

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
      getCredential: async () => CRED,
      onLargeFilesSkipped: (files) => {
        skipped.push(files)
      },
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
      getCredential: async () => CRED,
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
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_push', 'git_commit_all', 'git_push'])
    engine.stop()
  })

  it('skips the push when a debounced pass finds nothing committed and nothing ahead', async () => {
    // The watcher re-reports a pull's own writes; the resulting cycle must
    // not buy a network round-trip for them.
    const calls = fakeGit((command) =>
      command === 'git_commit_all' ? CLEAN_COMMIT : defaultResponses(command),
    )
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

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
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    await engine.syncNow()

    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch', 'git_merge_remote'])
    engine.stop()
  })

  it('a full sync cancels a pending debounced pass instead of double-running', async () => {
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
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

  it('localOnly commits and never touches the network — even for a full sync', async () => {
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
      localOnly: true,
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()
    await engine.syncNow()

    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_commit_all'])
    engine.stop()
  })

  it('stop() cancels pending work', async () => {
    const calls = fakeGit(defaultResponses)
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

    engine.noteChanged()
    engine.stop()
    await vi.runAllTimersAsync()

    expect(calls).toHaveLength(0)
  })

  it('passes a missing credential through as null (Rust owns the failure)', async () => {
    // The engine has no null-credential special case on purpose: only the remote
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
      getCredential: async () => null,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await vi.runAllTimersAsync()

    const push = calls.find((call) => call.command === 'git_push')
    expect(push?.args['credential']).toBeNull()
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('ignores edits arriving after stop() — the abort is sticky', async () => {
    const calls = fakeGit(defaultResponses)
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
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    const first = engine.syncNow()
    const second = engine.syncNow()
    const third = engine.syncNow()
    await vi.runAllTimersAsync()
    // Only the first cycle has started; the others coalesced, not interleaved.
    expect(commandsOf(calls)).toEqual([
      'git_commit_all',
      'git_fetch',
      'git_merge_remote',
      'git_push',
    ])

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

  it('stops at the next command boundary when cycles become suppressed', async () => {
    let canStartCycle = true
    const fetchGate: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const calls = fakeGit((command) => {
      if (command === 'git_fetch') {
        return new Promise((resolve) => {
          fetchGate.resolve = resolve
        })
      }
      return defaultResponses(command)
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
    await vi.advanceTimersByTimeAsync(0)
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch'])

    canStartCycle = false
    fetchGate.resolve?.(DELTA)
    await syncing

    // Fetch began while allowed, but merge/push must not start after the
    // lifecycle becomes hidden. Suppression is an idle pause, not an error.
    expect(commandsOf(calls)).toEqual(['git_commit_all', 'git_fetch'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
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
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
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
