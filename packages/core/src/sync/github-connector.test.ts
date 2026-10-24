import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestHttpService } from '../testing/http.ts'
import { createTestGitSyncService, createTestGithubAuthService } from '../testing/sync.ts'
import { createGithubConnector } from './github-connector.ts'
import { createGithubRepoService } from './github-repo-service.ts'

const PAT = { kind: 'pat', token: 'ghp_abc' } as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function setup(options: { signedIn?: boolean } = {}) {
  const http = createTestHttpService()
  const githubAuth = createTestGithubAuthService({
    http,
    ...(options.signedIn === false ? {} : { auth: PAT }),
  })
  const gitSync = createTestGitSyncService()
  const connector = createGithubConnector({
    githubAuth,
    githubRepos: createGithubRepoService({ http }),
    gitSync,
  })
  return { http, githubAuth, gitSync, connector }
}

describe('GithubConnector', () => {
  it('connectNewRepo creates a private repo and connects to its default branch', async () => {
    const { http, gitSync, connector } = setup()
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

    expect(await connector.connectNewRepo('g-backup')).toBe('connected')

    expect(JSON.parse(http.requests()[0]?.body ?? '')).toMatchObject({
      name: 'g-backup',
      private: true,
    })
    expect(gitSync.calls()).toEqual([
      {
        method: 'connectRemote',
        remoteUrl: 'https://github.com/alex/g-backup.git',
        branch: 'main',
      },
    ])
  })

  it('connectNewRepo hands a token that cannot create repos to the manual path', async () => {
    const { http, gitSync, connector } = setup()
    http.on(
      'POST',
      'https://api.github.com/user/repos',
      jsonResponse({ message: 'Resource not accessible by personal access token' }, 403),
    )

    expect(await connector.connectNewRepo('g-backup')).toBe('manualCreateNeeded')
    expect(gitSync.calls()).toEqual([])
  })

  it('connectExistingRepo reports a missing repo without touching the graph', async () => {
    const { http, gitSync, connector } = setup()
    http.on(
      'GET',
      'https://api.github.com/repos/alex/gone',
      jsonResponse({ message: 'Not Found' }, 404),
    )

    expect(await connector.connectExistingRepo({ owner: 'alex', name: 'gone' })).toBe('notFound')
    expect(gitSync.calls()).toEqual([])
  })

  it('connectExistingRepo demands explicit consent before a public repo', async () => {
    const { http, gitSync, connector } = setup()
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
    const ref = { owner: 'alex', name: 'public-notes' }

    expect(await connector.connectExistingRepo(ref)).toBe('needsPublicConfirm')
    expect(gitSync.calls()).toEqual([])

    expect(await connector.connectExistingRepo(ref, { allowPublic: true })).toBe('connected')
    // The repo's default branch is where the existing history lives.
    expect(gitSync.calls()).toEqual([
      {
        method: 'connectRemote',
        remoteUrl: 'https://github.com/alex/public-notes.git',
        branch: 'master',
      },
    ])
  })

  it('refuses to connect while signed out', async () => {
    const { gitSync, connector } = setup({ signedIn: false })
    await expect(connector.connectNewRepo('g-backup')).rejects.toThrow(AppError)
    expect(gitSync.calls()).toEqual([])
  })
})
