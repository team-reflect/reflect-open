import { z } from 'zod'
import { call } from '../ipc/invoke'

/**
 * Typed bindings for the Rust git primitives (Plan 12). The Rust layer is
 * remote-agnostic — URLs and per-call tokens, nothing GitHub-specific (that
 * lives in `./github`). Policy (cadence, retries, product states) is
 * `./engine`'s job; these are the verbs it composes.
 */

/** Snapshot of the graph's backup repository. */
export const gitStatusSchema = z.object({
  initialized: z.boolean(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  dirtyPaths: z.array(z.string()),
  ahead: z.number(),
  behind: z.number(),
  inProgress: z.boolean(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>

/** A file excluded from backup by the size guardrail (GitHub hard-fails >100 MB). */
export const skippedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
})
export type SkippedFile = z.infer<typeof skippedFileSchema>

export const commitOutcomeSchema = z.object({
  committed: z.boolean(),
  sha: z.string().nullable(),
  skippedLargeFiles: z.array(skippedFileSchema),
})
export type CommitOutcome = z.infer<typeof commitOutcomeSchema>

export const remoteDeltaSchema = z.object({
  ahead: z.number(),
  behind: z.number(),
})
export type RemoteDelta = z.infer<typeof remoteDeltaSchema>

/** A file a merge rewrote on disk — same shape as the watcher's FileChange. */
export const changedFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
})
export type ChangedFile = z.infer<typeof changedFileSchema>

export const mergeOutcomeSchema = z.object({
  kind: z.enum(['upToDate', 'fastForward', 'merged', 'mergedWithConflicts']),
  conflictedPaths: z.array(z.string()),
  /**
   * Every file the merge changed. The caller reindexes these directly —
   * pulls must not depend on the file watcher being up (on launch it may
   * not be yet) to keep the index in step with the notes.
   */
  changedFiles: z.array(changedFileSchema),
})
export type MergeOutcome = z.infer<typeof mergeOutcomeSchema>

export const pushOutcomeSchema = z.object({
  pushed: z.boolean(),
  nonFastForward: z.boolean(),
  rejectionMessage: z.string().nullable(),
})
export type PushOutcome = z.infer<typeof pushOutcomeSchema>

/** Snapshot the backup repository (cheap, no network). */
export async function gitStatus(): Promise<GitStatus> {
  return call('git_status', {}, gitStatusSchema)
}

/**
 * Initialize (or adopt) the graph repository; `remoteUrl` points `origin` at
 * the backup remote and `branch` aligns the local branch with the remote's
 * default (an existing repo on `master` must not end up shadowed by a
 * parallel local `main`). Idempotent.
 */
export async function gitSetup(
  remoteUrl: string | null,
  branch: string | null,
  generation: number,
): Promise<GitStatus> {
  return call('git_setup', { remoteUrl, branch, generation }, gitStatusSchema)
}

/** Commit every pending change (no-op when the tree is clean). */
export async function gitCommitAll(message: string, generation: number): Promise<CommitOutcome> {
  return call('git_commit_all', { message, generation }, commitOutcomeSchema)
}

/** Fetch `origin`; returns ahead/behind for the current branch. */
export async function gitFetch(token: string | null, generation: number): Promise<RemoteDelta> {
  return call('git_fetch', { token, generation }, remoteDeltaSchema)
}

/**
 * Merge the fetched remote branch. Conflicts are committed into the notes as
 * labeled markers — the repo is never left mid-merge, and the indexer turns
 * the markers into `Needs review` flags.
 */
export async function gitMergeRemote(generation: number): Promise<MergeOutcome> {
  return call('git_merge_remote', { generation }, mergeOutcomeSchema)
}

/** Push to `origin`; rejections come back as data, not thrown errors. */
export async function gitPush(token: string | null, generation: number): Promise<PushOutcome> {
  return call('git_push', { token, generation }, pushOutcomeSchema)
}
