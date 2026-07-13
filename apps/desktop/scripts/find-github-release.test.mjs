import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'find-github-release.sh')

function runLookup({ output, repository = 'team-reflect/reflect-open', status = 0, tag = 'v0.6.0-beta.14' }) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'find-github-release-'))
  const mockGhPath = join(temporaryDirectory, 'gh')
  const argsPath = join(temporaryDirectory, 'args.txt')
  writeFileSync(
    mockGhPath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" > "$MOCK_GH_ARGS_PATH"
if [ "$MOCK_GH_STATUS" -ne 0 ]; then
  echo 'mock gh failure' >&2
  exit "$MOCK_GH_STATUS"
fi
printf '%s' "$MOCK_GH_OUTPUT"
`,
  )
  chmodSync(mockGhPath, 0o755)

  try {
    const result = spawnSync('bash', [scriptPath, tag], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        MOCK_GH_ARGS_PATH: argsPath,
        MOCK_GH_OUTPUT: output,
        MOCK_GH_STATUS: String(status),
        PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
      },
    })
    return {
      args: existsSync(argsPath) ? readFileSync(argsPath, 'utf8').trim() : '',
      exitCode: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}

test('finds a draft release by exact tag', () => {
  const draft = {
    draft: true,
    prerelease: true,
    published_at: null,
    tag_name: 'v0.6.0-beta.14',
    target_commitish: 'a'.repeat(40),
  }
  const result = runLookup({
    output: JSON.stringify([{ tag_name: 'v0.6.0-beta.13' }, draft]),
  })

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(draft)
  expect(result.args).toBe(
    'api --paginate repos/team-reflect/reflect-open/releases?per_page=100',
  )
})

test('finds a published release on a later page', () => {
  const published = {
    draft: false,
    prerelease: false,
    published_at: '2026-07-13T20:00:00Z',
    tag_name: 'v0.6.0',
    target_commitish: 'b'.repeat(40),
  }
  const result = runLookup({
    output: `${JSON.stringify([{ tag_name: 'v0.5.0' }])}\n${JSON.stringify([published])}`,
    tag: 'v0.6.0',
  })

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(published)
})

test('prints null when no release matches', () => {
  const result = runLookup({ output: JSON.stringify([{ tag_name: 'v0.5.0' }]) })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('null\n')
})

test('fails closed when multiple releases use the tag', () => {
  const release = { tag_name: 'v0.6.0-beta.14' }
  const result = runLookup({ output: `${JSON.stringify([release])}\n${JSON.stringify([release])}` })

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('multiple releases use tag v0.6.0-beta.14')
})

test('propagates GitHub API failures instead of reporting an absent release', () => {
  const result = runLookup({ output: '', status: 2 })

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('mock gh failure')
  expect(result.stdout).not.toBe('null\n')
})

test('rejects invalid repository and tag inputs before calling GitHub', () => {
  const invalidRepository = runLookup({ output: '[]', repository: 'not-a-repository' })
  const invalidTag = runLookup({ output: '[]', tag: 'latest' })

  expect(invalidRepository.exitCode).toBe(1)
  expect(invalidRepository.stderr).toContain('GITHUB_REPOSITORY must be an owner/repository name')
  expect(invalidTag.exitCode).toBe(1)
  expect(invalidTag.stderr).toContain('invalid release tag latest')
})
