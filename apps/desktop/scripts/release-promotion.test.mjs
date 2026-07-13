import { describe, expect, test } from 'vitest'

import {
  PROMOTION_BASE_BRANCH,
  PROMOTION_BRANCH,
  createPromotionPrCreateArgs,
  createPromotionPrEditArgs,
  createPromotionPrListArgs,
  createPromotionPrMetadata,
  decideBranchUpdate,
  parseManagedPromotionPrNumbers,
  validateBetaTag,
  validateCommitSha,
  validateGitHubRepository,
} from './release-promotion.mjs'

const repository = 'team-reflect/reflect-open'

describe('beta tag validation', () => {
  test.each([
    ['v0.6.0-beta', '0.6.0-beta', '0.6.0'],
    ['v0.6.0-beta.14', '0.6.0-beta.14', '0.6.0'],
    ['v1.0.0-beta.0', '1.0.0-beta.0', '1.0.0'],
  ])('accepts %s', (tag, version, stableVersion) => {
    expect(validateBetaTag(tag)).toEqual({ tag, version, stableVersion })
  })

  test.each([
    '0.6.0-beta.14',
    'v0.6.0',
    'v0.6.0-alpha.1',
    'v0.6.0-beta.01',
    'v01.6.0-beta.1',
    'v0.6-beta.1',
    'v0.6.0-beta.1-extra',
  ])('rejects %s', (tag) => {
    expect(() => validateBetaTag(tag)).toThrow('expected a beta tag')
  })
})

test('release commit validation requires an immutable full SHA', () => {
  expect(validateCommitSha('A'.repeat(40))).toBe('a'.repeat(40))
  expect(() => validateCommitSha('abc123')).toThrow('40-character release commit SHA')
})

describe('promotion branch updates', () => {
  test('creates a missing branch', () => {
    expect(
      decideBranchUpdate({
        currentCommit: null,
        targetCommit: 'bbbb',
      }),
    ).toBe('create')
  })

  test('keeps a branch already pinned to the beta commit', () => {
    expect(
      decideBranchUpdate({
        currentCommit: 'bbbb',
        targetCommit: 'bbbb',
        currentIsAncestorOfTarget: true,
        targetIsAncestorOfCurrent: true,
      }),
    ).toBe('unchanged')
  })

  test('fast-forwards an older promotion commit', () => {
    expect(
      decideBranchUpdate({
        currentCommit: 'aaaa',
        targetCommit: 'bbbb',
        currentIsAncestorOfTarget: true,
        targetIsAncestorOfCurrent: false,
      }),
    ).toBe('fast-forward')
  })

  test('refuses to roll the promotion branch backward', () => {
    expect(
      decideBranchUpdate({
        currentCommit: 'bbbb',
        targetCommit: 'aaaa',
        currentIsAncestorOfTarget: false,
        targetIsAncestorOfCurrent: true,
      }),
    ).toBe('stale')
  })

  test('refuses to replace the promotion branch with divergent history', () => {
    expect(() =>
      decideBranchUpdate({
        currentCommit: 'aaaa',
        targetCommit: 'bbbb',
        currentIsAncestorOfTarget: false,
        targetIsAncestorOfCurrent: false,
      }),
    ).toThrow('divergent')
  })
})

test('promotion PR metadata makes the stable release contract explicit', () => {
  const metadata = createPromotionPrMetadata('v0.6.0-beta.14')

  expect(metadata).toEqual({
    base: PROMOTION_BASE_BRANCH,
    head: PROMOTION_BRANCH,
    title: 'chore: promote v0.6.0-beta.14 to stable 0.6.0',
    body: expect.stringContaining('single human approval'),
  })
  expect(metadata.body).toContain('Create a merge commit')
  expect(metadata.body).toContain('Do not squash or rebase')
  expect(metadata.body).toContain('`v0.6.0-beta.14`')
})

test('promotion PR arguments pin the base and rolling head branches', () => {
  const metadata = createPromotionPrMetadata('v1.0.0-beta')

  expect(createPromotionPrCreateArgs(metadata, repository)).toEqual([
    'pr',
    'create',
    '--repo',
    repository,
    '--base',
    'master',
    '--head',
    'release-promotion/latest-beta',
    '--title',
    metadata.title,
    '--body',
    metadata.body,
  ])
  expect(createPromotionPrEditArgs({ metadata, number: 123, repository })).toEqual([
    'pr',
    'edit',
    '123',
    '--repo',
    repository,
    '--title',
    metadata.title,
    '--body',
    metadata.body,
  ])
  expect(createPromotionPrListArgs(repository)).toEqual([
    'pr',
    'list',
    '--repo',
    repository,
    '--state',
    'open',
    '--base',
    'master',
    '--head',
    'release-promotion/latest-beta',
    '--json',
    'number,baseRefName,headRefName,headRepository,isCrossRepository',
    '--limit',
    '10',
  ])
})

describe('managed promotion PR discovery', () => {
  test('keeps the same-repository PR and ignores a fork with the same branch name', () => {
    const output = JSON.stringify([
      {
        number: 123,
        baseRefName: PROMOTION_BASE_BRANCH,
        headRefName: PROMOTION_BRANCH,
        headRepository: { nameWithOwner: repository },
        isCrossRepository: false,
      },
      {
        number: 456,
        baseRefName: PROMOTION_BASE_BRANCH,
        headRefName: PROMOTION_BRANCH,
        headRepository: { nameWithOwner: 'untrusted/reflect-open' },
        isCrossRepository: true,
      },
    ])

    expect(parseManagedPromotionPrNumbers(output, repository)).toEqual([123])
  })

  test('ignores same-named branches whose repository identity does not match', () => {
    const output = JSON.stringify([
      {
        number: 456,
        baseRefName: PROMOTION_BASE_BRANCH,
        headRefName: PROMOTION_BRANCH,
        headRepository: { nameWithOwner: 'untrusted/reflect-open' },
        isCrossRepository: false,
      },
    ])

    expect(parseManagedPromotionPrNumbers(output, repository)).toEqual([])
  })

  test('rejects malformed GitHub output and repository identifiers', () => {
    expect(() => parseManagedPromotionPrNumbers('{', repository)).toThrow('invalid JSON')
    expect(() => validateGitHubRepository('reflect-open')).toThrow('owner/name')
  })
})
