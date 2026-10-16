/**
 * `@reflect/core` sync domain (Plan 12) — GitHub backup & sync over the Rust
 * git primitives: the git schemas, the GitHub module (device flow, token
 * refresh, repo API), and the debounced sync engine's types.
 */
export {
  gitStatusSchema,
  commitOutcomeSchema,
  remoteDeltaSchema,
  pullOutcomeSchema,
  pushOutcomeSchema,
  skippedFileSchema,
  changedFileSchema,
  type GitCredential,
  type GitStatus,
  type CommitOutcome,
  type RemoteDelta,
  type PullOutcome,
  type PushOutcome,
  type SkippedFile,
  type ChangedFile,
} from './git-repository-service.ts'
export {
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_SLUG,
  GITHUB_AUTH_SECRET,
  githubAppInstallUrl,
  isDeviceFlowConfigured,
  githubAuthSchema,
  githubCredential,
  type GithubAuth,
  type DeviceFlowStart,
  type DevicePollResult,
  type RunDeviceFlowOptions,
  type GithubUser,
} from './github-auth-service.ts'
export {
  parseGithubRemote,
  remoteHost,
  parseRepoInput,
  suggestRepoName,
  githubRemoteUrl,
  newRepoUrl,
  BACKUP_REPO_DESCRIPTION,
  type GithubRepoRef,
  type GithubRepo,
} from './github-repo-service.ts'
export type { PublishedGist, GistFile } from './gist-service.ts'
export {
  isSyncError,
  type SyncEngine,
  type SyncEngineOptions,
  type SyncErrorKind,
  type SyncStatus,
} from './engine.ts'
