import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import type { FileChange } from '../indexing/file-change-service.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestFileChangeService, type TestFileChangeService } from '../testing/file-change.ts'
import { createTestHttpService, type TestHttpService } from '../testing/http.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import { createTestProgressPort } from '../testing/ports.ts'
import {
  createTestPersistenceFlushService,
  type TestPersistenceFlushService,
} from '../testing/persistence-flush.ts'
import { createTestPlatformService } from '../testing/platform.ts'
import { createTestSecretStoreService } from '../testing/secrets.ts'
import { createTestActivityPort, type TestActivityPort } from '../testing/shell.ts'
import {
  createTestGitRepositoryService,
  createTestGithubAuthService,
  createTestICloudNativeService,
  type TestGitRepositoryService,
  type TestICloudNativeService,
} from '../testing/sync.ts'
import { createCredentialResolver } from './credential-resolver.ts'
import { createSyncEngineFactory } from './engine.ts'
import { createGitHostCredentialService } from './git-host-credential-service.ts'
import { createGithubRepoService } from './github-repo-service.ts'
import {
  createGitSyncService,
  type GitSyncService,
  type GitSyncServiceDeps,
  type GitSyncState,
} from './git-sync-service.ts'
import type {
  ChangedFile,
  CommitOutcome,
  GitStatus,
  PullOutcome,
  PushOutcome,
} from './git-repository-service.ts'

let http: TestHttpService
let clock: TestClockService
let activity: TestActivityPort
let logger: TestLoggerService
let fileChanges: TestFileChangeService
let persistenceFlush: TestPersistenceFlushService
let gitSyncDeps: GitSyncServiceDeps
let icloudNative: TestICloudNativeService

beforeEach(() => {
  http = createTestHttpService()
  clock = createTestClockService()
  activity = createTestActivityPort()
  logger = createTestLoggerService()
  fileChanges = createTestFileChangeService()
  persistenceFlush = createTestPersistenceFlushService()
  icloudNative = createTestICloudNativeService()
})

const USER_URL = 'https://api.github.com/user'

/**
 * The graph generation every git command must be pinned to.
 */
const GENERATION = 3

const AUTH = JSON.stringify({ kind: 'pat', token: 'ghp_abc' })
const COMMITTED: CommitOutcome = {
  committed: true,
  sha: null,
  ahead: 0,
  skippedLargeFiles: [],
}
const PULLED: PullOutcome = {
  committed: true,
  ahead: 0,
  skippedLargeFiles: [],
  reviewPaths: [],
  changedFiles: [],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FakeOptions {
  auth?: string | null
  /**
   * Hold the direct index write until `releaseIndexApply()` (the convergence barrier).
   */
  gateIndexApply?: boolean
  /**
   * Make every direct index write throw (the projection-failure path).
   */
  failIndexApply?: boolean
  /**
   * Hold the first `status` until `releaseStatus()` (the teardown-race window).
   */
  gateStatus?: boolean
  /**
   * Hold the first `setup` until `releaseSetup()` (the dispose-during-setup window).
   */
  gateSetup?: boolean
  /**
   * Hold the first `pull` until `releasePull()` (the mid-pull window).
   */
  gatePull?: boolean
  /**
   * Hold the first `commitAll` until `releaseCommit()` (a flush still in flight).
   */
  gateCommit?: boolean
  /**
   * Make the watcher subscription throw (the unusable-watcher path).
   */
  failListen?: boolean
  failStatus?: boolean
  /**
   * Make the keychain read throw (locked keychain, stale ACL after re-signing).
   */
  failSecretGet?: boolean
  /**
   * Scripted `commitAll` outcome (defaults to a clean tree).
   */
  commitOutcome?: CommitOutcome
  /**
   * Scripted `pull` outcome (defaults to up-to-date).
   */
  pullOutcome?: PullOutcome
  /**
   * Per-call pull outcomes for retry/convergence tests.
   */
  pullOutcomes?: PullOutcome[]
  /**
   * Per-call push outcomes for retry/convergence tests.
   */
  pushOutcomes?: PushOutcome[]
  /**
   * Make every `push` throw this error (transport-level failures).
   */
  pushError?: Error | undefined
  /**
   * The graph's origin (defaults to a GitHub HTTPS remote; null = none).
   */
  remoteUrl?: string | null
  /**
   * Whether the graph already has a repository (defaults to true).
   */
  initialized?: boolean
  /**
   * Run as the mobile app (defaults to the desktop native shell).
   */
  mobile?: boolean
}

/**
 * Build the git sync factory over fakes with a mutable repo status, recording
 * every git command and direct index write by method name.
 */
function fakeServices(options: FakeOptions = {}) {
  const calls: string[] = []
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = []
  const record = (command: string, args: Record<string, unknown>): void => {
    calls.push(command)
    invocations.push({ command, args })
  }
  const auth = options.auth === undefined ? AUTH : options.auth
  const status: GitStatus = {
    initialized: options.initialized ?? true,
    branch: 'main',
    remoteUrl:
      options.remoteUrl === undefined ? 'https://github.com/alex/notes.git' : options.remoteUrl,
    ahead: 0,
    behind: 0,
  }
  const statusGate = Promise.withResolvers<void>()
  const indexApplyGate = Promise.withResolvers<void>()
  const setupGate = Promise.withResolvers<void>()
  const pullGate = Promise.withResolvers<void>()
  const commitGate = Promise.withResolvers<void>()
  let statusCount = 0
  let pullCount = 0
  let commitInvocations = 0
  let indexApplyCount = 0
  const pullOutcomes = [...(options.pullOutcomes ?? [])]
  const pushOutcomes = [...(options.pushOutcomes ?? [])]
  const initialSecrets: Record<string, string> = {}
  if (auth !== null) {
    initialSecrets['github-auth'] = auth
  }
  const secretStore = createTestSecretStoreService(initialSecrets)
  if (options.failSecretGet === true) {
    vi.spyOn(secretStore, 'get').mockRejectedValue(new AppError('io', 'keychain unavailable'))
  }

  const git = createTestGitRepositoryService()
  git.onStatus(async (generation) => {
    record('status', { generation })
    statusCount += 1
    if (options.gateStatus === true && statusCount === 1) {
      await statusGate.promise
    }
    if (options.failStatus === true) {
      throw new AppError('io', 'broken repo')
    }
    return { ...status }
  })
  git.onSetup(async (remoteUrl, branch, generation) => {
    record('setup', { remoteUrl, branch, generation })
    if (options.gateSetup === true) {
      await setupGate.promise
    }
    status.initialized = true
    status.remoteUrl = remoteUrl
    return { ...status }
  })
  git.onCommitAll(async (fallbackMessage, generation) => {
    record('commitAll', { fallbackMessage, generation })
    commitInvocations += 1
    if (options.gateCommit === true && commitInvocations === 1) {
      await commitGate.promise
    }
    const outcome = options.commitOutcome ?? COMMITTED
    if (outcome.committed) {
      calls.push('committed')
    }
    return outcome
  })
  git.onFetch((credential, generation) => {
    record('fetch', { credential, generation })
    return { ahead: 0, behind: 0 }
  })
  git.onPull(async (_fallbackMessage, generation) => {
    record('pull', { generation })
    pullCount += 1
    if (options.gatePull === true && pullCount === 1) {
      await pullGate.promise
    }
    const outcome = pullOutcomes.shift() ?? options.pullOutcome ?? PULLED
    if (outcome.committed) {
      calls.push('committed')
    }
    return outcome
  })
  git.onPush((credential, generation) => {
    record('push', { credential, generation })
    if (options.pushError !== undefined) {
      throw options.pushError
    }
    return pushOutcomes.shift() ?? { pushed: true, nonFastForward: false, rejectionMessage: null }
  })
  git.onDisconnect((generation) => {
    record('disconnect', { generation })
    status.remoteUrl = null
    return { ...status }
  })

  if (options.failListen === true) {
    vi.spyOn(fileChanges, 'subscribe').mockImplementation(() => {
      throw new AppError('io', 'watcher unavailable')
    })
  }

  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'applyChanges').mockImplementation(
    async (changes, generation, _fileGeneration, canApply) => {
      if (canApply?.() === false) {
        return 0
      }
      record('applyChanges', { paths: changes.map((change) => change.path), generation })
      indexApplyCount += 1
      if (options.failIndexApply === true) {
        throw new AppError('io', 'index write failed')
      }
      if (options.gateIndexApply === true && indexApplyCount === 1) {
        await indexApplyGate.promise
      }
      return changes.length
    },
  )

  const progress = createTestProgressPort()
  const githubAuth = createTestGithubAuthService({ secretStore, http, clock })
  const hostCredentials = createGitHostCredentialService({ secretStore, logger })
  gitSyncDeps = {
    git,
    syncEngines: createSyncEngineFactory({ git, clock }),
    credentials: createCredentialResolver({ githubAuth, hostCredentials, logger }),
    githubAuth,
    hostCredentials,
    githubRepos: createGithubRepoService({ http }),
    fileChanges,
    indexLifecycle,
    progress,
    clock,
    activity,
    platform: createTestPlatformService({ surface: { mobileApp: options.mobile ?? false } }),
    persistenceFlush,
    logger,
    icloudNative,
  }
  return {
    git,
    calls,
    invocations,
    progress,
    secrets: secretStore,
    status,
    releaseStatus: () => statusGate.resolve(),
    releaseSetup: () => setupGate.resolve(),
    releaseIndexApply: () => indexApplyGate.resolve(),
    releasePull: () => pullGate.resolve(),
    releaseCommit: () => commitGate.resolve(),
  }
}

/**
 * A git sync service of the last {@link fakeServices} call, at graph generation 3.
 */
function createGitSync(options: {
  indexGeneration: number | null
  root?: string | undefined
}): GitSyncService {
  return createGitSyncService(gitSyncDeps, {
    root: options.root ?? '/graph',
    generation: GENERATION,
    indexGeneration: options.indexGeneration,
  })
}

/**
 * Let every promise chain that is already runnable settle.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Move the clock by `ms`, running the timers that come due, then settle.
 */
async function advance(ms: number): Promise<void> {
  await clock.advance(ms)
  await flush()
}

/**
 * Commits made: `commitAll` and `pull` outcomes that report `committed: true`.
 */
function commitCount(calls: string[]): number {
  return calls.filter((command) => command === 'committed').length
}

function trackStates(gitSync: GitSyncService): GitSyncState[] {
  const states: GitSyncState[] = []
  gitSync.subscribe(() => {
    states.push(gitSync.getState())
  })
  return states
}

const ICLOUD_ROOT = '/Users/a/Library/Mobile Documents/iCloud~app/Documents/Notes'

describe('createGitSyncService', () => {
  it('an iCloud graph with a remote waits for quiet before fetching', async () => {
    const { calls } = fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1, root: ICLOUD_ROOT })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'waiting', until: 5 * 60_000 },
      })
    })
    expect(calls).toContain('commitAll')
    expect(calls).not.toContain('fetch')

    await advance(5 * 60_000)
    await vi.waitFor(() => {
      expect(calls).toContain('fetch')
    })
    expect(icloudNative.calls()).toEqual([{ method: 'pendingCount', args: [ICLOUD_ROOT, 'notes'] }])
    gitSync.dispose()
  })

  it('an unchanged state does not notify listeners', async () => {
    fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({ status: { state: 'idle' } })
    })
    const states = trackStates(gitSync)
    await gitSync.syncNow()
    await flush()
    expect(states.length).toBeGreaterThan(0)
    for (let i = 1; i < states.length; i++) {
      expect(states[i]).not.toEqual(states[i - 1])
    }
    expect(states.at(-1)).toMatchObject({ status: { state: 'idle' } })
    gitSync.dispose()
  })

  it('a folder graph never enters quiet mode', async () => {
    const { calls } = fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(calls).toContain('fetch')
    })
    expect(gitSync.getState()).toMatchObject({ status: { state: 'idle' } })
    expect(icloudNative.calls()).toEqual([])
    gitSync.dispose()
  })

  describe('remote probe', () => {
    const MOVED = { remoteOid: 'b', trackingOid: 'a' }

    async function startSettled(options: Parameters<typeof fakeServices>[0], root?: string) {
      const services = fakeServices(options)
      const gitSync = createGitSync({ indexGeneration: 1, root })
      await gitSync.start()
      await vi.waitFor(() => {
        const state = gitSync.getState()
        expect.assert(state.phase === 'connected')
        expect(state.status.state).toMatch(/idle|waiting/)
      })
      return { ...services, gitSync }
    }

    it('probes the remote while visible and pulls when it moved', async () => {
      const { git, calls, gitSync } = await startSettled({})
      try {
        const probes: Array<unknown> = []
        let tip: { remoteOid: string | null; trackingOid: string | null } = {
          remoteOid: 'a',
          trackingOid: 'a',
        }
        git.onRemoteHead((credential, generation) => {
          probes.push([credential, generation])
          return tip
        })
        const fetches = calls.filter((command) => command === 'fetch').length

        await advance(90_000)
        expect(probes).toHaveLength(1)
        expect(probes[0]).toEqual([{ username: 'x-access-token', secret: 'ghp_abc' }, GENERATION])
        expect(calls.filter((command) => command === 'fetch')).toHaveLength(fetches)

        tip = { remoteOid: null, trackingOid: 'a' } // the remote branch is gone
        await advance(90_000)
        expect(calls.filter((command) => command === 'fetch')).toHaveLength(fetches)

        tip = MOVED
        await advance(90_000)
        expect(probes).toHaveLength(3)
        await vi.waitFor(() => {
          expect(calls.filter((command) => command === 'fetch')).toHaveLength(fetches + 1)
        })
      } finally {
        gitSync.dispose()
      }
    })

    it('does not probe iCloud-hosted graphs, mobile, hidden windows, or while in error', async () => {
      let probes = 0
      const probed = (): number => probes
      const watch = (git: TestGitRepositoryService): void => {
        git.onRemoteHead(() => {
          probes += 1
          return MOVED
        })
      }

      const icloud = await startSettled({}, ICLOUD_ROOT)
      watch(icloud.git)
      await advance(5 * 60_000)
      icloud.gitSync.dispose()
      expect(probed()).toBe(0)

      const mobile = await startSettled({ mobile: true })
      watch(mobile.git)
      await advance(5 * 60_000)
      mobile.gitSync.dispose()
      expect(probed()).toBe(0)

      const hidden = await startSettled({})
      watch(hidden.git)
      activity.setHidden(true)
      await advance(5 * 60_000)
      expect(probed()).toBe(0)
      activity.setHidden(false)
      await advance(90_000)
      expect(probed()).toBe(1)
      hidden.gitSync.dispose()

      const failing = await startSettled({})
      watch(failing.git)
      failing.git.onPush(() => {
        throw new AppError('auth', 'bad token')
      })
      failing.git.onPull(() => ({ ...PULLED, committed: true, ahead: 1 }))
      void failing.gitSync.syncNow()
      await vi.waitFor(() => {
        expect(failing.gitSync.getState()).toMatchObject({ status: { state: 'error' } })
      })
      const before = probed()
      await advance(5 * 60_000)
      expect(probed()).toBe(before)
      failing.gitSync.dispose()
    })
  })

  it('a mobile cycle hidden after its commit pushes', async () => {
    const { git, calls } = fakeServices({
      mobile: true,
      pullOutcome: { ...PULLED, committed: false },
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    try {
      await gitSync.start()
      await vi.waitFor(() => {
        expect(gitSync.getState()).toMatchObject({ status: { state: 'idle' } })
      })
      git.onCommitAll(() => {
        activity.setHidden(true)
        return { committed: true, sha: 'c', ahead: 1, skippedLargeFiles: [] }
      })
      fileChanges.emit({
        changes: [{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }],
        source: 'external',
      })
      await advance(10_000)
      await vi.waitFor(() => {
        expect(calls.filter((command) => command === 'push')).toHaveLength(1)
      })
    } finally {
      gitSync.dispose()
    }
  })

  it('clearing the GitHub sign-in restarts into needsCredential', async () => {
    const { secrets } = fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    expect(gitSync.getState()).toMatchObject({ phase: 'connected' })

    await gitSyncDeps.githubAuth.clear()
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({ phase: 'needsCredential' })
    })

    expect(secrets.snapshot()).not.toHaveProperty('github-auth')
    gitSync.dispose()
  })

  it('storing a host sign-in restarts a remote that was waiting for it', async () => {
    const { calls } = fakeServices({ auth: null, remoteUrl: 'https://gitlab.com/alex/notes.git' })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    expect(gitSync.getState()).toMatchObject({ phase: 'needsCredential' })

    await gitSyncDeps.hostCredentials.save('https://gitlab.com', {
      username: 'alex',
      secret: 'glpat-1',
    })
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({ phase: 'connected' })
    })
    await vi.waitFor(() => {
      expect(calls).toContain('fetch')
    })
    gitSync.dispose()
  })

  it('needs a credential when no GitHub sign-in is stored — but keeps local history', async () => {
    // Signing out of GitHub (or a lapsed credential) stops the *sync*, not
    // the note history: the graph already has a repo, so the commit-only loop
    // takes over. Losing history here is a silent downgrade the user never
    // asked for. The remote stays on record, so the UI can name it.
    const { calls } = fakeServices({ auth: null })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    expect(gitSync.getState()).toEqual({
      phase: 'needsCredential',
      remoteUrl: 'https://github.com/alex/notes.git',
      remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
    })
    await vi.waitFor(() => {
      expect(calls).toContain('commitAll')
    })
    // The repo is already initialized, and nothing may touch the network.
    expect(calls).not.toContain('setup')
    expect(calls).not.toContain('fetch')
    expect(calls).not.toContain('push')
    gitSync.dispose()
  })

  it('keeps committing on edits after the GitHub credential is gone', async () => {
    const { calls } = fakeServices({ auth: null })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1)
    })

    fileChanges.emit({
      changes: [{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    await advance(30_000)
    expect(commitCount(calls)).toBe(2)
    expect(calls).not.toContain('push')
    gitSync.dispose()
  })

  it('adopts a hand-wired generic remote without any stored credential', async () => {
    // Plan 16 V1: a non-GitHub origin (here SSH) needs no GitHub sign-in —
    // its credentials live with the user's git tooling, resolved in Rust.
    const { calls, invocations } = fakeServices({
      auth: null,
      remoteUrl: 'git@gitlab.com:alex/notes.git',
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(calls).toContain('fetch')
    })

    expect(gitSync.getState()).toMatchObject({
      phase: 'connected',
      remoteUrl: 'git@gitlab.com:alex/notes.git',
      remote: { kind: 'ssh', host: 'gitlab.com' },
      isPrimaryChannel: true,
    })
    const fetch = invocations.find(({ command }) => command === 'fetch')
    expect(fetch?.args).toMatchObject({ credential: null })
    gitSync.dispose()
  })

  it('syncs an HTTPS host with its stored sign-in, re-read every cycle', async () => {
    const { invocations, secrets } = fakeServices({
      auth: null,
      remoteUrl: 'https://gitlab.com/alex/notes.git',
    })
    await secrets.set(
      'git-credential:https://gitlab.com',
      JSON.stringify({ username: 'alex', secret: 'glpat-1' }),
    )
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(invocations.some(({ command }) => command === 'push')).toBe(true)
    })
    expect(gitSync.getState()).toMatchObject({
      phase: 'connected',
      remote: { kind: 'https', origin: 'https://gitlab.com' },
    })
    for (const { command, args } of invocations) {
      if (command === 'fetch' || command === 'push') {
        expect(args).toMatchObject({ credential: { username: 'alex', secret: 'glpat-1' } })
      }
    }

    // A rotated token reaches the next cycle without a restart.
    await secrets.set(
      'git-credential:https://gitlab.com',
      JSON.stringify({ username: 'alex', secret: 'glpat-2' }),
    )
    await gitSync.syncNow()
    const lastPush = invocations.findLast(({ command }) => command === 'push')
    expect(lastPush?.args).toMatchObject({ credential: { username: 'alex', secret: 'glpat-2' } })
    gitSync.dispose()
  })

  it('never offers a host sign-in to another origin', async () => {
    const { calls, secrets } = fakeServices({
      auth: null,
      remoteUrl: 'https://gitlab.com:8443/alex/notes.git',
    })
    await secrets.set(
      'git-credential:https://gitlab.com',
      JSON.stringify({ username: 'alex', secret: 'glpat-1' }),
    )
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    expect(gitSync.getState()).toMatchObject({
      phase: 'needsCredential',
      remote: { kind: 'https', origin: 'https://gitlab.com:8443' },
    })
    expect(calls).not.toContain('fetch')
    gitSync.dispose()
  })

  it('never offers the GitHub token to a generic remote', async () => {
    // A GitHub credential in the keychain + a foreign origin: the token must
    // not ride along as basic auth to a host the user never authorized.
    const { invocations } = fakeServices({ remoteUrl: 'git@gitlab.com:alex/notes.git' })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(invocations.some(({ command }) => command === 'fetch')).toBe(true)
    })

    for (const { command, args } of invocations) {
      if (command === 'fetch' || command === 'push') {
        expect(args).toMatchObject({ credential: null })
      }
    }
    gitSync.dispose()
  })

  it('needs a credential for an HTTPS host with no stored sign-in', async () => {
    // A *public* generic HTTPS remote would pull anonymously and only fail
    // on push — edits arriving while the user's own never leave. The guard
    // surfaces the state before the engine ever starts, and the GitHub
    // sign-in in the keychain is never offered to the host.
    const { calls } = fakeServices({ remoteUrl: 'https://gitlab.com/alex/notes.git' })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    expect(gitSync.getState()).toEqual({
      phase: 'needsCredential',
      remoteUrl: 'https://gitlab.com/alex/notes.git',
      remote: { kind: 'https', origin: 'https://gitlab.com' },
    })

    // No *sync* engine: the launch snapshot is local history's only commit,
    // and focus buys nothing further, because the resume triggers belong to
    // the sync engine that never started. The remote stays unadopted, and
    // nothing on this path may touch the network.
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1)
    })
    activity.emitResume()
    await flush()
    expect(commitCount(calls)).toBe(1)
    expect(calls).not.toContain('fetch')
    expect(calls).not.toContain('push')
    gitSync.dispose()
  })

  it('keeps the missing-credential state when local history cannot start', async () => {
    // Local history is best effort: a watcher that won't come up must not cost
    // the user the one hint they have for fixing the remote.
    fakeServices({ remoteUrl: 'https://gitlab.com/alex/notes.git', failListen: true })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    expect(gitSync.getState()).toMatchObject({
      phase: 'needsCredential',
      remote: { kind: 'https', origin: 'https://gitlab.com' },
    })
    expect(logger.getErrors()).toContainEqual({
      message: 'local history failed to start:',
      cause: 'watcher unavailable',
    })
    gitSync.dispose()
  })

  it('keeps local history when the keychain itself cannot be read', async () => {
    // A keychain read that throws is the same user-visible situation as a
    // missing credential, so it must not fail the whole start into the
    // engine-less catch and take the graph's history with it.
    const { calls } = fakeServices({ failSecretGet: true })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    expect(gitSync.getState()).toMatchObject({ phase: 'needsCredential' })
    await vi.waitFor(() => {
      expect(calls).toContain('commitAll')
    })
    expect(calls).not.toContain('fetch')
    expect(calls).not.toContain('push')
    expect(logger.getErrors()).toContainEqual({
      message: 'reading the GitHub credential failed:',
      cause: expect.any(String) as string,
    })
    gitSync.dispose()
  })

  it('runs the launch pull when fully connected — and skips the idle push', async () => {
    const { calls } = fakeServices({ pullOutcome: { ...PULLED, committed: false } })
    const gitSync = createGitSync({ indexGeneration: 1 })
    const states = trackStates(gitSync)
    await gitSync.start()
    await vi.waitFor(() => {
      expect(calls).toContain('pull')
    })

    expect(states.at(-1)).toMatchObject({ phase: 'connected', status: { state: 'idle' } })
    // Both sides in step: the cycle must end without a network push.
    expect(calls).not.toContain('push')
    gitSync.dispose()
  })

  it('disposing mid-probe stops before any engine or git work runs', async () => {
    const { calls, releaseStatus } = fakeServices({ gateStatus: true })
    const gitSync = createGitSync({ indexGeneration: 1 })
    const started = gitSync.start()
    await vi.waitFor(() => {
      expect(calls).toContain('status')
    })

    gitSync.dispose() // teardown wins the race against the probe
    releaseStatus()
    await started
    await flush()

    expect(calls).not.toContain('commitAll')
    expect(calls.filter((command) => command === 'status')).toHaveLength(1)
  })

  it('initializes local history on desktop when no backup is configured', async () => {
    const { calls, invocations } = fakeServices({ auth: null, initialized: false, remoteUrl: null })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    // The UI never learns about local history — the graph reads as disconnected.
    expect(gitSync.getState()).toEqual({ phase: 'disconnected' })
    const setup = invocations.find(({ command }) => command === 'setup')
    expect(setup?.args).toMatchObject({ remoteUrl: null, branch: null, generation: GENERATION })
    await vi.waitFor(() => {
      expect(calls).toContain('commitAll') // first snapshot on launch
    })
    expect(calls).not.toContain('fetch')
    expect(calls).not.toContain('push')
    gitSync.dispose()
  })

  it('disposing while local history sets up creates no engine', async () => {
    const { calls, releaseSetup } = fakeServices({
      auth: null,
      initialized: false,
      remoteUrl: null,
      gateSetup: true,
    })
    const create = vi.spyOn(gitSyncDeps.syncEngines, 'create')
    const subscribe = vi.spyOn(fileChanges, 'subscribe')
    const gitSync = createGitSync({ indexGeneration: 1 })
    const started = gitSync.start()
    await vi.waitFor(() => {
      expect(calls).toContain('setup')
    })

    gitSync.dispose()
    releaseSetup()
    await started
    await flush()

    expect(create).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(calls).not.toContain('commitAll')
  })

  it('local history keeps committing on edits — still with no network', async () => {
    // A repo without a remote (e.g. after disconnectGraph) needs no git_setup.
    const { calls } = fakeServices({ auth: null, remoteUrl: null })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1)
    })
    expect(calls).not.toContain('setup')

    fileChanges.emit({
      changes: [{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    await advance(30_000)
    expect(commitCount(calls)).toBe(2)
    expect(calls).not.toContain('fetch')
    expect(calls).not.toContain('push')
    gitSync.dispose()
  })

  it('a pull batch does not tick the commit debounce', async () => {
    const { calls } = fakeServices({ auth: null, remoteUrl: null })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1)
    })

    fileChanges.emit({
      changes: [{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'pull',
    })
    await advance(30_000)
    expect(commitCount(calls)).toBe(1)
    gitSync.dispose()
  })

  it('an icloud-sweep batch ticks the commit debounce', async () => {
    const { calls } = fakeServices({ auth: null, remoteUrl: null })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1)
    })

    fileChanges.emit({
      changes: [{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'icloud-sweep',
    })
    await advance(30_000)
    expect(commitCount(calls)).toBe(2)
    gitSync.dispose()
  })

  it('never starts local history on mobile', async () => {
    const { calls } = fakeServices({
      auth: null,
      initialized: false,
      remoteUrl: null,
      mobile: true,
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await flush()

    expect(gitSync.getState()).toEqual({ phase: 'disconnected' })
    expect(calls).not.toContain('setup')
    expect(calls).not.toContain('commitAll')
    gitSync.dispose()
  })

  it('disconnectGraph drops the remote and lands on disconnected', async () => {
    const { calls } = fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    await gitSync.disconnectGraph()

    expect(calls).toContain('disconnect')
    expect(gitSync.getState()).toEqual({ phase: 'disconnected' })
    gitSync.dispose()
  })

  it('a failed probe tears down to disconnected instead of leaving a zombie', async () => {
    const { calls } = fakeServices({ failStatus: true })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    expect(gitSync.getState()).toEqual({ phase: 'disconnected' })
    expect(calls).not.toContain('commitAll')
    expect(logger.getErrors()).toEqual([{ message: 'backup start failed:', cause: 'broken repo' }])
    gitSync.dispose()
  })

  it('connectNewRepo creates a private repo and connects to its default branch', async () => {
    const { invocations } = fakeServices()
    http.on(
      'POST',
      'https://api.github.com/user/repos',
      jsonResponse(
        {
          full_name: 'alex/g-backup',
          private: true,
          default_branch: 'main',
          html_url: 'https://github.com/alex/g-backup',
        },
        201,
      ),
    )
    const gitSync = createGitSync({ indexGeneration: 1 })

    await gitSync.connectNewRepo('g-backup')

    expect(JSON.parse(http.requests()[0]?.body ?? '')).toMatchObject({
      name: 'g-backup',
      private: true,
    })
    const setup = invocations.find(({ command }) => command === 'setup')
    expect(setup?.args).toMatchObject({
      remoteUrl: 'https://github.com/alex/g-backup.git',
      branch: 'main',
      generation: GENERATION,
    })
    expect(gitSync.getState()).toMatchObject({
      phase: 'connected',
      remote: { kind: 'github', repo: { owner: 'alex', name: 'g-backup' } },
    })
    gitSync.dispose()
  })

  it('connectExistingRepo reports a missing repo without touching the graph', async () => {
    const { calls } = fakeServices()
    http.on(
      'GET',
      'https://api.github.com/repos/alex/gone',
      jsonResponse({ message: 'Not Found' }, 404),
    )
    const gitSync = createGitSync({ indexGeneration: 1 })

    expect(await gitSync.connectExistingRepo({ owner: 'alex', name: 'gone' })).toBe('notFound')
    expect(calls).not.toContain('setup')
    gitSync.dispose()
  })

  it('connectExistingRepo demands explicit consent before a public repo', async () => {
    const { calls, invocations } = fakeServices()
    http.on(
      'GET',
      'https://api.github.com/repos/alex/public-notes',
      jsonResponse({
        full_name: 'alex/public-notes',
        private: false,
        default_branch: 'master',
        html_url: 'https://github.com/alex/public-notes',
      }),
    )
    const gitSync = createGitSync({ indexGeneration: 1 })
    const ref = { owner: 'alex', name: 'public-notes' }

    expect(await gitSync.connectExistingRepo(ref)).toBe('needsPublicConfirm')
    expect(calls).not.toContain('setup')

    expect(await gitSync.connectExistingRepo(ref, { allowPublic: true })).toBe('connected')
    const setup = invocations.find(({ command }) => command === 'setup')
    // The repo's default branch is where the existing backup history lives.
    expect(setup?.args).toMatchObject({ branch: 'master' })
    gitSync.dispose()
  })

  it('signOut clears the machine credential and lands on needsCredential', async () => {
    const { secrets } = fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    expect(gitSync.getState()).toMatchObject({ phase: 'connected' })

    await gitSync.signOut()

    expect(secrets.snapshot()).not.toHaveProperty('github-auth')
    expect(gitSync.getState()).toMatchObject({ phase: 'needsCredential' })
    gitSync.dispose()
  })

  // libgit2 reports every 403 as an auth failure, but GitHub also answers
  // 403 for a token without access to the repo and for rate limiting; the
  // backup asks GitHub whether the token is good before blaming it.
  const FORBIDDEN = new AppError('auth', 'request failed with status code: 403')
  const MERGED: PullOutcome = { ...PULLED, ahead: 1 }

  it('a 403 with a valid token reports a refused sync, not a bad credential', async () => {
    fakeServices({ pullOutcome: MERGED, pushError: FORBIDDEN })
    http.on('GET', USER_URL, jsonResponse({ login: 'alex' }))
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'error', errorKind: 'rejected' },
      })
    })
    const state = gitSync.getState()
    expect(
      state.phase === 'connected' && state.status.state === 'error' && state.status.message,
    ).toContain('alex/notes')
    gitSync.dispose()
  })

  it('a 403 with a rejected token stays an auth error', async () => {
    fakeServices({ pullOutcome: MERGED, pushError: FORBIDDEN })
    http.on('GET', USER_URL, jsonResponse({ message: 'Bad credentials' }, 401))
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(http.requests()).not.toHaveLength(0)
    })
    // Let the probe's rejection settle before asserting nothing changed.
    await flush()
    expect(gitSync.getState()).toMatchObject({
      phase: 'connected',
      status: { state: 'error', errorKind: 'auth' },
    })
    gitSync.dispose()
  })

  it('a 403 with a token probe that never reaches GitHub reports offline', async () => {
    fakeServices({ pullOutcome: MERGED, pushError: FORBIDDEN })
    http.on('GET', USER_URL, () => {
      throw new TypeError('Failed to fetch')
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'offline' },
      })
    })
    gitSync.dispose()
  })

  it('a 403 with a rate-limited token probe reports offline, not a bad credential', async () => {
    fakeServices({ pullOutcome: MERGED, pushError: FORBIDDEN })
    http.on('GET', USER_URL, jsonResponse({ message: 'API rate limit exceeded' }, 403))
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'offline' },
      })
    })
    gitSync.dispose()
  })

  // Safety invariant S4 (docs/git-backup-safety.md): the quit-time commit
  // queues behind an in-flight cycle, so it can never land between a pull's
  // ref move and its checkout and commit the stale tree (#1405).
  it('quit flush waits for an in-flight pull before committing', async () => {
    const { calls, releasePull, releaseCommit } = fakeServices({
      gatePull: true,
      gateCommit: true,
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    try {
      await vi.waitFor(() => {
        expect(calls).toContain('pull')
      })

      let flushResolved = false
      const flushed = persistenceFlush.flushAll().then(() => {
        flushResolved = true
      })
      await Promise.resolve()
      // The pull is still between fetch and merge: no commit may run yet.
      expect(calls).not.toContain('commitAll')

      releasePull()
      await vi.waitFor(() => {
        expect(calls).toContain('commitAll')
      })
      // The flush resolves with its commit, not before it.
      expect(flushResolved).toBe(false)
      releaseCommit()
      await flushed
    } finally {
      releasePull()
      releaseCommit()
      gitSync.dispose()
    }
  })

  it('the mobile background flush commits while the document is hidden', async () => {
    const { calls } = fakeServices({ mobile: true })
    const gitSync = createGitSync({ indexGeneration: 1 })
    try {
      await gitSync.start()
      await vi.waitFor(() => {
        expect(calls).toContain('pull') // the launch cycle ran
      })
      const before = commitCount(calls)

      activity.setHidden(true)
      await persistenceFlush.flushAll()
      expect(commitCount(calls)).toBe(before + 1)
    } finally {
      gitSync.dispose()
    }
  })

  it('a resume (window focus, network back, visible again) triggers a sync', async () => {
    const { calls } = fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1 })
    try {
      await gitSync.start()
      await vi.waitFor(() => {
        expect(commitCount(calls)).toBe(1) // the launch pull's commit
      })

      activity.emitResume()
      await vi.waitFor(() => {
        expect(commitCount(calls)).toBe(2)
      })
    } finally {
      gitSync.dispose()
    }
  })

  it('stops listening for resumes once disposed', async () => {
    const { calls } = fakeServices()
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1) // the launch pull's commit
    })

    gitSync.dispose()
    activity.emitResume()
    await flush()
    expect(commitCount(calls)).toBe(1)
  })

  it('going hidden does not trigger a cycle (backgrounding is the flush path)', async () => {
    const { calls } = fakeServices()
    activity.setHidden(true)
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(commitCount(calls)).toBe(1)
    })

    activity.emitHidden()
    await flush()
    expect(commitCount(calls)).toBe(1)

    gitSync.dispose()
  })

  it('defers mobile launch, online, and debounce cycles until foreground', async () => {
    const { calls } = fakeServices({ mobile: true })
    activity.setHidden(true)
    const gitSync = createGitSync({ indexGeneration: 1 })
    try {
      await gitSync.start()
      await flush()

      // Adoption may probe status/auth while hidden, but the launch cycle must
      // not acquire the Git index or touch the network.
      expect(calls).not.toContain('commitAll')
      expect(calls).not.toContain('fetch')

      activity.emitVisible()
      activity.emitResume()
      await vi.waitFor(() => {
        expect(commitCount(calls)).toBe(1)
        expect(calls.filter((command) => command === 'fetch')).toHaveLength(1)
      })

      activity.emitHidden()
      fileChanges.emit({
        changes: [{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }],
        source: 'external',
      })
      activity.emitResume() // the network came back while hidden
      await advance(10_000)

      // Both the immediate online trigger and the edit's 10s mobile debounce
      // are dropped while hidden.
      expect(commitCount(calls)).toBe(1)
      expect(calls.filter((command) => command === 'fetch')).toHaveLength(1)

      activity.emitVisible()
      activity.emitResume()
      await flush()
      expect(commitCount(calls)).toBe(2)
      // Foreground replay is full, so it fetches rather than merely pushing
      // the edit that arrived while hidden.
      expect(calls.filter((command) => command === 'fetch')).toHaveLength(2)
    } finally {
      gitSync.dispose()
    }
  })

  it('an edit backs up after 30s idle on desktop, 10s on mobile', async () => {
    async function debouncedCommitDelay(mobile: boolean): Promise<number> {
      const { calls } = fakeServices({ mobile })
      const gitSync = createGitSync({ indexGeneration: 1 })
      try {
        await gitSync.start()
        await vi.waitFor(() => {
          expect(commitCount(calls)).toBe(1) // the launch pull's commit
        })
        fileChanges.emit({
          changes: [{ path: 'notes/edited.md', kind: 'upsert', modifiedMs: 1 }],
          source: 'external',
        })
        await advance(10_000)
        if (commitCount(calls) > 1) {
          return 10_000
        }
        await advance(20_000)
        return commitCount(calls) > 1 ? 30_000 : Infinity
      } finally {
        gitSync.dispose()
      }
    }

    expect(await debouncedCommitDelay(false)).toBe(30_000)
    expect(await debouncedCommitDelay(true)).toBe(10_000)
  })

  it('fans a pull’s writes whole to the local file-changes channel — consumers filter by path', async () => {
    fakeServices({
      pullOutcome: {
        committed: false,
        ahead: 1,
        skippedLargeFiles: [],
        reviewPaths: [],
        changedFiles: [
          { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 123 },
          { path: 'daily/2026-06-11.md', kind: 'remove', modifiedMs: null },
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
    const unlisten = fileChanges.subscribe(({ changes }) => {
      batches.push(changes)
    })
    const gitSync = createGitSync({ indexGeneration: null })
    await gitSync.start()

    await vi.waitFor(() => {
      expect(batches).toHaveLength(1)
    })
    expect(batches[0]).toEqual([
      { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 123 },
      { path: 'daily/2026-06-11.md', kind: 'remove' },
      { path: 'audio-memos/audio-memo-2026-06-11-090000-000.m4a', kind: 'upsert', modifiedMs: 456 },
    ])
    gitSync.dispose()
    unlisten()
  })

  it('a hint lists every copy by its graph path', async () => {
    const { progress } = fakeServices({
      pullOutcome: {
        committed: false,
        ahead: 0,
        skippedLargeFiles: [],
        reviewPaths: [
          'notes/a (conflict 2026-10-16 08-05-31 a1b2c3d4).png',
          'notes/b (conflict 2026-10-16 08-05-31 e5f6a7b8).md',
        ],
        changedFiles: [],
      },
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    await vi.waitFor(() => {
      expect(progress.snapshot()).toEqual([
        expect.objectContaining({
          label: 'Syncing',
          status: 'failed',
          message:
            'Kept 2 conflict copies: notes/a (conflict 2026-10-16 08-05-31 a1b2c3d4).png, notes/b (conflict 2026-10-16 08-05-31 e5f6a7b8).md',
        }),
      ])
    })
    gitSync.dispose()
  })

  it('fans retry-merge batches immediately while serializing direct indexing', async () => {
    const firstChange: ChangedFile = {
      path: 'notes/from-remote-1.md',
      kind: 'upsert',
      modifiedMs: 123,
    }
    const secondChange: ChangedFile = {
      path: 'notes/from-remote-2.md',
      kind: 'upsert',
      modifiedMs: 456,
    }
    const { calls, releaseIndexApply } = fakeServices({
      gateIndexApply: true,
      pullOutcomes: [
        { ...PULLED, ahead: 1, changedFiles: [firstChange] },
        { ...PULLED, ahead: 1, changedFiles: [secondChange] },
      ],
      pushOutcomes: [
        { pushed: false, nonFastForward: true, rejectionMessage: 'fetch first' },
        { pushed: true, nonFastForward: false, rejectionMessage: null },
      ],
    })
    const batches: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      batches.push(changes)
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    try {
      await vi.waitFor(() => {
        expect(calls.filter((command) => command === 'push')).toHaveLength(2)
        expect(batches).toEqual([[firstChange], [secondChange]])
      })
      // The second callback already fanned out synchronously, but its direct
      // index write is queued behind the first gated batch.
      expect(calls.filter((command) => command === 'applyChanges')).toHaveLength(1)
      expect(gitSync.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'syncing' },
      })

      releaseIndexApply()
      await vi.waitFor(() => {
        expect(calls.filter((command) => command === 'applyChanges')).toHaveLength(2)
        expect(gitSync.getState()).toMatchObject({
          phase: 'connected',
          status: { state: 'idle' },
        })
      })
    } finally {
      gitSync.dispose()
      unlisten()
    }
  })

  it('does not start queued direct indexing after backup teardown', async () => {
    const { calls, releaseIndexApply } = fakeServices({
      gateIndexApply: true,
      pullOutcomes: [
        {
          ...PULLED,
          committed: false,
          ahead: 1,
          changedFiles: [{ path: 'notes/from-remote-1.md', kind: 'upsert', modifiedMs: 123 }],
        },
        {
          ...PULLED,
          committed: false,
          ahead: 1,
          changedFiles: [{ path: 'notes/from-remote-2.md', kind: 'upsert', modifiedMs: 456 }],
        },
      ],
      pushOutcomes: [
        { pushed: false, nonFastForward: true, rejectionMessage: 'fetch first' },
        { pushed: true, nonFastForward: false, rejectionMessage: null },
      ],
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    await vi.waitFor(() => {
      expect(calls.filter((command) => command === 'push')).toHaveLength(2)
      expect(calls.filter((command) => command === 'applyChanges')).toHaveLength(1)
    })

    gitSync.dispose()
    releaseIndexApply()
    // The first, already-running apply can finish. The second task then reaches
    // the backup-owned tail, observes the teardown epoch, and must exit
    // before touching the index bridge.
    await flush()

    expect(calls.filter((command) => command === 'applyChanges')).toHaveLength(1)
  })

  it('keeps launch sync active until pulled notes finish direct indexing', async () => {
    const { calls, releaseIndexApply } = fakeServices({
      gateIndexApply: true,
      pullOutcome: {
        ...PULLED,
        committed: false,
        ahead: 0,
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 123 }],
      },
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    await vi.waitFor(() => {
      expect(calls).toContain('applyChanges')
    })
    expect(gitSync.getState()).toMatchObject({
      phase: 'connected',
      status: { state: 'syncing' },
    })

    releaseIndexApply()
    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'idle' },
      })
    })
    gitSync.dispose()
  })

  it('still settles to idle when direct indexing fails — projection health never blocks backup', async () => {
    const { calls } = fakeServices({
      failIndexApply: true,
      pullOutcome: {
        ...PULLED,
        committed: false,
        ahead: 0,
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 123 }],
      },
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()

    await vi.waitFor(() => {
      expect(gitSync.getState()).toMatchObject({
        phase: 'connected',
        status: { state: 'idle' },
      })
    })
    expect(calls).toContain('applyChanges')
    // The failure is reported, never thrown into the sync cycle — the
    // projection is rebuildable, the push is not.
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'pulled-note direct index apply failed:',
    ])
    gitSync.dispose()
  })

  it('defers a pulled note direct-index apply while the mobile app is hidden', async () => {
    const { calls } = fakeServices({
      mobile: true,
      pullOutcome: {
        ...PULLED,
        committed: false,
        ahead: 1,
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 123 }],
      },
    })
    activity.setHidden(true)
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await flush()

    expect(calls).not.toContain('applyChanges')
    gitSync.dispose()
  })

  it('skips the direct-index apply when the mobile app went hidden mid-pull', async () => {
    const { calls, releasePull } = fakeServices({
      mobile: true,
      gatePull: true,
      pullOutcome: {
        ...PULLED,
        committed: false,
        ahead: 1,
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert', modifiedMs: 123 }],
      },
    })
    const batches: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      batches.push(changes)
    })
    const gitSync = createGitSync({ indexGeneration: 1 })
    await gitSync.start()
    await vi.waitFor(() => {
      expect(calls).toContain('pull')
    })

    activity.setHidden(true)
    releasePull()
    await vi.waitFor(() => {
      expect(batches).toHaveLength(1) // the landed merge still fans out
    })
    await flush()

    expect(calls).not.toContain('applyChanges')
    gitSync.dispose()
    unlisten()
  })
})
