import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createGitRepositoryService } from './git-repository-service.ts'
const STATUS = {
  initialized: true,
  branch: 'main',
  remoteUrl: 'https://github.com/a/b.git',
  ahead: 0,
  behind: 0,
  inProgress: false,
}
const CRED = { username: 'x-access-token', secret: 'tok' }

describe('createGitRepositoryService', () => {
  it('sends each method to its command with the generation', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        git_status: () => STATUS,
        git_setup: () => STATUS,
        git_disconnect: () => ({ ...STATUS, remoteUrl: null }),
        git_commit_all: () => ({ committed: true, sha: 'abc', ahead: 1, skippedLargeFiles: [] }),
        git_fetch: () => ({ ahead: 1, behind: 2 }),
        git_push: () => ({ pushed: true, nonFastForward: false, rejectionMessage: null }),
        git_merge_remote: () => ({ kind: 'merged', reviewPaths: [], changedFiles: [] }),
      },
    })
    const git = createGitRepositoryService({ ipc })

    await expect(git.status(3)).resolves.toEqual(STATUS)
    await git.setup('https://github.com/a/b.git', 'main', 3)
    await expect(git.disconnect(3)).resolves.toMatchObject({ remoteUrl: null })
    await expect(git.commitAll('Update notes', 3)).resolves.toMatchObject({ sha: 'abc' })
    await expect(git.fetch(CRED, 3)).resolves.toEqual({ ahead: 1, behind: 2 })
    await expect(git.push(null, 3)).resolves.toMatchObject({ pushed: true })
    await expect(git.mergeRemote(3)).resolves.toMatchObject({ kind: 'merged' })

    expect(ipc.calls()).toEqual([
      { command: 'git_status', args: { generation: 3 } },
      {
        command: 'git_setup',
        args: { remoteUrl: 'https://github.com/a/b.git', branch: 'main', generation: 3 },
      },
      { command: 'git_disconnect', args: { generation: 3 } },
      { command: 'git_commit_all', args: { message: 'Update notes', generation: 3 } },
      { command: 'git_fetch', args: { credential: CRED, generation: 3 } },
      { command: 'git_push', args: { credential: null, generation: 3 } },
      { command: 'git_merge_remote', args: { generation: 3 } },
    ])
  })

  it('rejects a malformed response with a parse error', async () => {
    const ipc = createTestIpcBridgeService({ commands: { git_fetch: () => ({ ahead: 'x' }) } })
    const git = createGitRepositoryService({ ipc })

    await expect(git.fetch(null, 1)).rejects.toMatchObject({ kind: 'parse' })
  })
})
