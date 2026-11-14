import type {
  CommitOutcome,
  GitCredential,
  GitStatus,
  PullOutcome,
  PushOutcome,
  RemoteDelta,
  RemoteTip,
} from '@reflect/types'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

export type {
  ChangedFile,
  CommitOutcome,
  GitCredential,
  GitStatus,
  PullOutcome,
  PushOutcome,
  RemoteDelta,
  RemoteTip,
  SkippedFile,
} from '@reflect/types'

/**
 * The Rust git primitives for the open graph's repository. The Rust layer is
 * remote-agnostic: URLs and a per-call {@link GitCredential}, nothing
 * GitHub-specific. Every method is pinned to the graph `generation` it was
 * issued for, so a command that lands after a graph switch fails instead of
 * touching the wrong repository.
 */
export interface GitRepositoryService {
  /**
   * Snapshot the backup repository (cheap, no network).
   */
  status(generation: number): Promise<GitStatus>
  /**
   * Initialize (or adopt) the graph repository; `remoteUrl` points `origin` at
   * the backup remote and `branch` aligns the local branch with the remote's
   * default (an existing repo on `master` must not end up shadowed by a
   * parallel local `main`). Idempotent.
   */
  setup(remoteUrl: string | null, branch: string | null, generation: number): Promise<GitStatus>
  /**
   * Stop backing this graph up: drop the `origin` remote. The repository and
   * its history stay; the machine-level credential is untouched.
   */
  disconnect(generation: number): Promise<GitStatus>
  /**
   * Commit every pending change (no-op when the tree is clean). `fallbackMessage`
   * is used only when Rust cannot derive a clearer subject from staged paths.
   */
  commitAll(fallbackMessage: string, generation: number): Promise<CommitOutcome>
  /**
   * Fetch `origin`; returns ahead/behind for the current branch.
   */
  fetch(credential: GitCredential | null, generation: number): Promise<RemoteDelta>
  /**
   * Ask `origin` (or `url`, a remote that is not configured yet) for the
   * current branch tip without fetching. `trackingOid` always describes
   * `origin`'s tracking ref, so it is `null` for a probe from a fresh repo.
   */
  remoteHead(credential: GitCredential | null, generation: number, url?: string): Promise<RemoteTip>
  /**
   * Push to `origin`; rejections come back as data, not thrown errors.
   */
  push(credential: GitCredential | null, generation: number): Promise<PushOutcome>
  /**
   * Commit local changes, then merge the fetched remote branch, under one
   * graph lock. Text conflicts are committed as merged text and other
   * conflicts keep a copy: the repo is never left mid-merge.
   */
  pull(fallbackMessage: string, generation: number): Promise<PullOutcome>
}

export interface GitRepositoryServiceDeps {
  readonly ipc: IpcBridgeService
}

class GitRepositoryServiceImpl implements GitRepositoryService {
  readonly #deps: GitRepositoryServiceDeps

  constructor(deps: GitRepositoryServiceDeps) {
    this.#deps = deps
  }

  status(generation: number): Promise<GitStatus> {
    return this.#deps.ipc.call('git_status', { generation })
  }

  setup(remoteUrl: string | null, branch: string | null, generation: number): Promise<GitStatus> {
    return this.#deps.ipc.call('git_setup', { remoteUrl, branch, generation })
  }

  disconnect(generation: number): Promise<GitStatus> {
    return this.#deps.ipc.call('git_disconnect', { generation })
  }

  commitAll(fallbackMessage: string, generation: number): Promise<CommitOutcome> {
    return this.#deps.ipc.call('git_commit_all', { message: fallbackMessage, generation })
  }

  fetch(credential: GitCredential | null, generation: number): Promise<RemoteDelta> {
    return this.#deps.ipc.call('git_fetch', { credential, generation })
  }

  remoteHead(
    credential: GitCredential | null,
    generation: number,
    url?: string,
  ): Promise<RemoteTip> {
    return this.#deps.ipc.call('git_remote_head', { url: url ?? null, credential, generation })
  }

  push(credential: GitCredential | null, generation: number): Promise<PushOutcome> {
    return this.#deps.ipc.call('git_push', { credential, generation })
  }

  pull(fallbackMessage: string, generation: number): Promise<PullOutcome> {
    return this.#deps.ipc.call('git_pull', { message: fallbackMessage, generation })
  }
}

export function createGitRepositoryService(deps: GitRepositoryServiceDeps): GitRepositoryService {
  return new GitRepositoryServiceImpl(deps)
}
