import type { MaybePromise } from '@reflect/utils'
import { AppError } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'
import type {
  ICloudNativeService,
  IcloudDownloadScope,
  IcloudScanOptions,
  IcloudStatus,
  IcloudSweepOutcome,
} from '../ipc/icloud-native-service.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { HttpService } from '../ports/http-service.ts'
import type { BackupService, BackupState, ConnectExistingResult } from '../sync/backup-service.ts'
import type { ICloudSyncService } from '../sync/icloud-sync-service.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import type {
  CommitOutcome,
  GitCredential,
  GitRepositoryService,
  GitStatus,
  PullOutcome,
  PushOutcome,
  RemoteDelta,
  RemoteTip,
} from '../sync/git-repository-service.ts'
import {
  createGithubAuthService,
  GITHUB_AUTH_SECRET,
  type DeviceFlowStart,
  type DevicePollResult,
  type GithubAuth,
  type GithubAuthService,
  type GithubAuthState,
  type GithubUser,
  type RunDeviceFlowOptions,
} from '../sync/github-auth-service.ts'
import type { GithubRepoRef } from '../sync/github-repo-service.ts'
import { createTestClockService } from './clock.ts'
import { createTestHttpService } from './http.ts'
import { createTestSecretStoreService } from './secrets.ts'

type GitMethod = keyof GitRepositoryService

/**
 * One recorded {@link GitRepositoryService} call.
 */
export type GitRepositoryCall = {
  [M in GitMethod]: { readonly method: M; readonly args: Parameters<GitRepositoryService[M]> }
}[GitMethod]

/**
 * Answers one {@link GitRepositoryService} method; may return the result directly or as a promise.
 */
export type GitRepositoryHandler<M extends GitMethod> = (
  ...args: Parameters<GitRepositoryService[M]>
) => Awaited<ReturnType<GitRepositoryService[M]>> | ReturnType<GitRepositoryService[M]>

export interface TestGitRepositoryService extends GitRepositoryService {
  calls(): readonly GitRepositoryCall[]
  onStatus(handler: GitRepositoryHandler<'status'>): void
  onSetup(handler: GitRepositoryHandler<'setup'>): void
  onDisconnect(handler: GitRepositoryHandler<'disconnect'>): void
  onCommitAll(handler: GitRepositoryHandler<'commitAll'>): void
  onFetch(handler: GitRepositoryHandler<'fetch'>): void
  onRemoteHead(handler: GitRepositoryHandler<'remoteHead'>): void
  onPush(handler: GitRepositoryHandler<'push'>): void
  onPull(handler: GitRepositoryHandler<'pull'>): void
}

/**
 * An in-memory {@link GitRepositoryService} that records every call. By
 * default `setup` and `disconnect` update the status, `commitAll` finds a
 * clean tree, `fetch` reports no delta, `push` succeeds and `pull` is
 * up to date; the `onXxx` setters replace one method's answer.
 */
class TestGitRepositoryServiceImpl implements TestGitRepositoryService {
  #status: GitStatus
  readonly #log: GitRepositoryCall[] = []
  readonly #handlers: { [M in GitMethod]: GitRepositoryHandler<M> } = {
    status: () => ({ ...this.#status }),
    setup: (remoteUrl, branch) => {
      this.#status = {
        ...this.#status,
        initialized: true,
        remoteUrl,
        branch: branch ?? this.#status.branch ?? 'main',
      }
      return { ...this.#status }
    },
    disconnect: () => {
      this.#status = { ...this.#status, remoteUrl: null }
      return { ...this.#status }
    },
    commitAll: (): CommitOutcome => ({
      committed: false,
      sha: null,
      ahead: 0,
      skippedLargeFiles: [],
    }),
    fetch: (): RemoteDelta => ({ ahead: 0, behind: 0 }),
    remoteHead: (): RemoteTip => ({ remoteOid: null, trackingOid: null }),
    push: (): PushOutcome => ({ pushed: true, nonFastForward: false, rejectionMessage: null }),
    pull: (): PullOutcome => ({
      committed: false,
      ahead: 0,
      skippedLargeFiles: [],
      reviewPaths: [],
      changedFiles: [],
    }),
  }

  constructor(initialStatus?: Partial<GitStatus>) {
    this.#status = {
      initialized: false,
      branch: null,
      remoteUrl: null,
      ahead: 0,
      behind: 0,
      ...initialStatus,
    }
  }

  async status(generation: number): Promise<GitStatus> {
    this.#log.push({ method: 'status', args: [generation] })
    return await this.#handlers.status(generation)
  }

  async setup(
    remoteUrl: string | null,
    branch: string | null,
    generation: number,
  ): Promise<GitStatus> {
    this.#log.push({ method: 'setup', args: [remoteUrl, branch, generation] })
    return await this.#handlers.setup(remoteUrl, branch, generation)
  }

  async disconnect(generation: number): Promise<GitStatus> {
    this.#log.push({ method: 'disconnect', args: [generation] })
    return await this.#handlers.disconnect(generation)
  }

  async commitAll(fallbackMessage: string, generation: number): Promise<CommitOutcome> {
    this.#log.push({ method: 'commitAll', args: [fallbackMessage, generation] })
    return await this.#handlers.commitAll(fallbackMessage, generation)
  }

  async fetch(credential: GitCredential | null, generation: number): Promise<RemoteDelta> {
    this.#log.push({ method: 'fetch', args: [credential, generation] })
    return await this.#handlers.fetch(credential, generation)
  }

  async remoteHead(credential: GitCredential | null, generation: number): Promise<RemoteTip> {
    this.#log.push({ method: 'remoteHead', args: [credential, generation] })
    return await this.#handlers.remoteHead(credential, generation)
  }

  async push(credential: GitCredential | null, generation: number): Promise<PushOutcome> {
    this.#log.push({ method: 'push', args: [credential, generation] })
    return await this.#handlers.push(credential, generation)
  }

  async pull(fallbackMessage: string, generation: number): Promise<PullOutcome> {
    this.#log.push({ method: 'pull', args: [fallbackMessage, generation] })
    return await this.#handlers.pull(fallbackMessage, generation)
  }

  calls(): readonly GitRepositoryCall[] {
    return [...this.#log]
  }

  onStatus(handler: GitRepositoryHandler<'status'>): void {
    this.#handlers.status = handler
  }

  onSetup(handler: GitRepositoryHandler<'setup'>): void {
    this.#handlers.setup = handler
  }

  onDisconnect(handler: GitRepositoryHandler<'disconnect'>): void {
    this.#handlers.disconnect = handler
  }

  onCommitAll(handler: GitRepositoryHandler<'commitAll'>): void {
    this.#handlers.commitAll = handler
  }

  onFetch(handler: GitRepositoryHandler<'fetch'>): void {
    this.#handlers.fetch = handler
  }

  onRemoteHead(handler: GitRepositoryHandler<'remoteHead'>): void {
    this.#handlers.remoteHead = handler
  }

  onPush(handler: GitRepositoryHandler<'push'>): void {
    this.#handlers.push = handler
  }

  onPull(handler: GitRepositoryHandler<'pull'>): void {
    this.#handlers.pull = handler
  }
}

export function createTestGitRepositoryService(
  initialStatus?: Partial<GitStatus>,
): TestGitRepositoryService {
  return new TestGitRepositoryServiceImpl(initialStatus)
}

type ICloudCommand = Exclude<
  keyof ICloudNativeService,
  'subscribeConflicts' | 'subscribeWatchFailed'
>

/**
 * One recorded {@link ICloudNativeService} command call.
 */
export type ICloudNativeCall = {
  [M in ICloudCommand]: { readonly method: M; readonly args: Parameters<ICloudNativeService[M]> }
}[ICloudCommand]

export interface TestICloudNativeService extends ICloudNativeService {
  calls(): readonly ICloudNativeCall[]
  setStatus(status: Partial<IcloudStatus>): void
  /**
   * What `downloadPending` and `pendingCount` report from now on.
   */
  setPendingCount(count: number): void
  onConflictsScan(handler: (options: IcloudScanOptions) => MaybePromise<IcloudSweepOutcome>): void
  emitConflicts(paths: string[]): void
  emitWatchFailed(): void
}

/**
 * An in-memory {@link ICloudNativeService}. The container is unavailable
 * unless `status` says otherwise; `adoptGraph` answers `<documentsRoot>/Notes`
 * and rejects with an `io` error while unavailable; sweeps change nothing.
 */
class TestICloudNativeServiceImpl implements TestICloudNativeService {
  #status: IcloudStatus
  #pending: number
  #scan: (scanOptions: IcloudScanOptions) => MaybePromise<IcloudSweepOutcome> = () => ({
    changed: [],
    copies: [],
    autoResolved: 0,
  })
  readonly #log: ICloudNativeCall[] = []
  readonly #conflictListeners = new Set<(paths: string[]) => void>()
  readonly #watchFailedListeners = new Set<() => void>()

  constructor(options?: { status?: Partial<IcloudStatus>; pendingCount?: number }) {
    this.#status = {
      available: false,
      documentsRoot: null,
      existingGraphRoots: [],
      ...options?.status,
    }
    this.#pending = options?.pendingCount ?? 0
  }

  async status(): Promise<IcloudStatus> {
    this.#log.push({ method: 'status', args: [] })
    return { ...this.#status, existingGraphRoots: [...this.#status.existingGraphRoots] }
  }

  async adoptGraph(generation: number): Promise<string> {
    this.#log.push({ method: 'adoptGraph', args: [generation] })
    if (!this.#status.available || this.#status.documentsRoot === null) {
      throw new AppError('io', 'test iCloud: the container is unavailable')
    }
    return `${this.#status.documentsRoot}/Notes`
  }

  async conflictsScan(scanOptions: IcloudScanOptions): Promise<IcloudSweepOutcome> {
    this.#log.push({ method: 'conflictsScan', args: [scanOptions] })
    return await this.#scan(scanOptions)
  }

  async watchStart(root: string): Promise<void> {
    this.#log.push({ method: 'watchStart', args: [root] })
  }

  async watchStop(): Promise<void> {
    this.#log.push({ method: 'watchStop', args: [] })
  }

  async downloadPending(root: string, scope: IcloudDownloadScope): Promise<number> {
    this.#log.push({ method: 'downloadPending', args: [root, scope] })
    return this.#pending
  }

  async pendingCount(root: string, scope: IcloudDownloadScope): Promise<number> {
    this.#log.push({ method: 'pendingCount', args: [root, scope] })
    return this.#pending
  }

  async requestDownloads(paths: string[]): Promise<number> {
    this.#log.push({ method: 'requestDownloads', args: [paths] })
    return paths.length
  }

  subscribeConflicts(listener: (paths: string[]) => void): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (paths: string[]): void => {
      listener(paths)
    }
    this.#conflictListeners.add(deliver)
    return () => {
      this.#conflictListeners.delete(deliver)
    }
  }

  subscribeWatchFailed(listener: () => void): Unlisten {
    const deliver = (): void => {
      listener()
    }
    this.#watchFailedListeners.add(deliver)
    return () => {
      this.#watchFailedListeners.delete(deliver)
    }
  }

  calls(): readonly ICloudNativeCall[] {
    return [...this.#log]
  }

  setStatus(next: Partial<IcloudStatus>): void {
    this.#status = { ...this.#status, ...next }
  }

  setPendingCount(count: number): void {
    this.#pending = count
  }

  onConflictsScan(handler: (options: IcloudScanOptions) => MaybePromise<IcloudSweepOutcome>): void {
    this.#scan = handler
  }

  emitConflicts(paths: string[]): void {
    for (const listener of this.#conflictListeners) {
      listener([...paths])
    }
  }

  emitWatchFailed(): void {
    for (const listener of this.#watchFailedListeners) {
      listener()
    }
  }
}

export function createTestICloudNativeService(options?: {
  status?: Partial<IcloudStatus>
  pendingCount?: number
}): TestICloudNativeService {
  return new TestICloudNativeServiceImpl(options)
}

export interface TestGithubAuthOptions {
  /**
   * The credential stored at the start; none by default. Ignored when `secretStore` is given.
   */
  auth?: GithubAuth
  /**
   * Defaults to an in-memory keychain holding `auth`.
   */
  secretStore?: SecretStoreService
  /**
   * Defaults to an HTTP fake with no routes.
   */
  http?: HttpService
  /**
   * Defaults to a test clock.
   */
  clock?: ClockService
}

export interface TestGithubAuthService extends GithubAuthService {
  /**
   * Answer `runDeviceFlow` with `handler` instead of running the flow over
   * HTTP; `null` restores the real flow.
   */
  onRunDeviceFlow(handler: GithubAuthService['runDeviceFlow'] | null): void
}

/**
 * The real {@link GithubAuthService} over an in-memory keychain, an HTTP fake
 * and a test clock. `onRunDeviceFlow` scripts the device flow.
 */
class TestGithubAuthServiceImpl implements TestGithubAuthService {
  readonly #inner: GithubAuthService
  #deviceFlow: GithubAuthService['runDeviceFlow'] | null = null

  constructor(options?: TestGithubAuthOptions) {
    this.#inner = createGithubAuthService({
      secretStore:
        options?.secretStore ??
        createTestSecretStoreService(
          options?.auth === undefined ? {} : { [GITHUB_AUTH_SECRET]: JSON.stringify(options.auth) },
        ),
      http: options?.http ?? createTestHttpService(),
      clock: options?.clock ?? createTestClockService(),
    })
  }

  readonly getState = (): GithubAuthState => this.#inner.getState()

  load(): Promise<GithubAuth | null> {
    return this.#inner.load()
  }

  save(auth: GithubAuth): Promise<void> {
    return this.#inner.save(auth)
  }

  clear(): Promise<void> {
    return this.#inner.clear()
  }

  readonly subscribe = (listener: () => void): Unlisten => this.#inner.subscribe(listener)

  getToken(): Promise<string | null> {
    return this.#inner.getToken()
  }

  deviceFlowStart(clientId?: string): Promise<DeviceFlowStart> {
    return this.#inner.deviceFlowStart(clientId)
  }

  deviceFlowPoll(deviceCode: string, clientId?: string): Promise<DevicePollResult> {
    return this.#inner.deviceFlowPoll(deviceCode, clientId)
  }

  runDeviceFlow(flowOptions: RunDeviceFlowOptions): Promise<GithubAuth | null> {
    return (this.#deviceFlow ?? this.#inner.runDeviceFlow)(flowOptions)
  }

  getAuthenticatedUser(token: string): Promise<GithubUser> {
    return this.#inner.getAuthenticatedUser(token)
  }

  getSignedInUser(): Promise<GithubUser | null> {
    return this.#inner.getSignedInUser()
  }

  onRunDeviceFlow(handler: GithubAuthService['runDeviceFlow'] | null): void {
    this.#deviceFlow = handler
  }
}

export function createTestGithubAuthService(
  options?: TestGithubAuthOptions,
): TestGithubAuthService {
  return new TestGithubAuthServiceImpl(options)
}

/**
 * One recorded {@link TestBackupService} action.
 */
export type BackupCall =
  | { readonly method: 'start' | 'disconnectGraph' | 'signOut' | 'backUpNow' | 'dispose' }
  | { readonly method: 'connectNewRepo'; readonly name: string }
  | {
      readonly method: 'connectExistingRepo'
      readonly ref: GithubRepoRef
      readonly allowPublic: boolean
    }

export interface TestBackupService extends BackupService {
  /**
   * Publish `state` as the backup state and notify subscribers.
   */
  setState(state: BackupState): void
  /**
   * Every action called, in order.
   */
  calls(): readonly BackupCall[]
  /**
   * Answer `connectNewRepo`; it resolves `connected` by default.
   */
  onConnectNewRepo(handler: BackupService['connectNewRepo']): void
  /**
   * Answer `connectExistingRepo`; it resolves `connected` by default.
   */
  onConnectExistingRepo(handler: BackupService['connectExistingRepo']): void
}

/**
 * A scripted {@link BackupService}: it runs no engine and touches no
 * repository. The state starts at `state` (`loading` by default) and moves
 * only through `setState`; every action is recorded.
 */
class TestBackupServiceImpl implements TestBackupService {
  #state: BackupState
  readonly #listeners = new Set<() => void>()
  readonly #log: BackupCall[] = []
  #connectNew: BackupService['connectNewRepo'] = async () => 'connected'
  #connectExisting: BackupService['connectExistingRepo'] =
    async (): Promise<ConnectExistingResult> => 'connected'

  constructor(options?: { state?: BackupState }) {
    this.#state = options?.state ?? { phase: 'loading' }
  }

  start(): void {
    this.#log.push({ method: 'start' })
  }

  readonly getState = (): BackupState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  async connectNewRepo(name: string): Promise<'connected' | 'manualCreateNeeded'> {
    this.#log.push({ method: 'connectNewRepo', name })
    return await this.#connectNew(name)
  }

  async connectExistingRepo(
    ref: GithubRepoRef,
    connectOptions?: { allowPublic?: boolean },
  ): Promise<ConnectExistingResult> {
    this.#log.push({
      method: 'connectExistingRepo',
      ref,
      allowPublic: connectOptions?.allowPublic ?? false,
    })
    return await this.#connectExisting(ref, connectOptions)
  }

  disconnectGraph(): void {
    this.#log.push({ method: 'disconnectGraph' })
  }

  signOut(): void {
    this.#log.push({ method: 'signOut' })
  }

  backUpNow(): void {
    this.#log.push({ method: 'backUpNow' })
  }

  dispose(): void {
    this.#log.push({ method: 'dispose' })
  }

  setState(next: BackupState): void {
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  calls(): readonly BackupCall[] {
    return [...this.#log]
  }

  onConnectNewRepo(handler: BackupService['connectNewRepo']): void {
    this.#connectNew = handler
  }

  onConnectExistingRepo(handler: BackupService['connectExistingRepo']): void {
    this.#connectExisting = handler
  }
}

export function createTestBackupService(options?: { state?: BackupState }): TestBackupService {
  return new TestBackupServiceImpl(options)
}

export interface TestICloudSyncService extends ICloudSyncService {
  /**
   * Every lifecycle method called, in order.
   */
  calls(): readonly ('start' | 'dispose')[]
}

/**
 * A scripted {@link ICloudSyncService}: it sweeps nothing and records its lifecycle calls.
 */
class TestICloudSyncServiceImpl implements TestICloudSyncService {
  readonly #log: ('start' | 'dispose')[] = []

  start(): void {
    this.#log.push('start')
  }

  dispose(): void {
    this.#log.push('dispose')
  }

  calls(): readonly ('start' | 'dispose')[] {
    return [...this.#log]
  }
}

export function createTestICloudSyncService(): TestICloudSyncService {
  return new TestICloudSyncServiceImpl()
}
