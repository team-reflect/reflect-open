// Maintain the rolling pull request that promotes the latest published beta
// snapshot from `next` to `master`.
//
// Usage:
//   node apps/desktop/scripts/release-promotion.mjs v0.6.0-beta.14 <commit-sha>

// The branch always points directly at a beta tag commit. It is only created
// or fast-forwarded, so an older or unrelated workflow run cannot replace a
// newer promotion candidate.

import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Rolling bot branch whose tip is the latest promotable beta tag commit. */
export const PROMOTION_BRANCH = 'release-promotion/latest-beta'
/** Stable branch targeted by the rolling promotion pull request. */
export const PROMOTION_BASE_BRANCH = 'master'
const DEVELOPMENT_BRANCH = 'next'
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i

const BETA_TAG_PATTERN =
  /^v(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)-beta(?:\.(?<prerelease>0|[1-9]\d*))?$/

function log(message) {
  console.log(`release-promotion: ${message}`)
}

function commandOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

/** Parse and validate a release-please beta tag. */
export function validateBetaTag(tag) {
  const match = BETA_TAG_PATTERN.exec(tag)
  if (!match?.groups) {
    throw new Error(`expected a beta tag like v0.6.0-beta or v0.6.0-beta.14, received "${tag}"`)
  }

  const stableVersion = `${match.groups.major}.${match.groups.minor}.${match.groups.patch}`
  return {
    tag,
    version: tag.slice(1),
    stableVersion,
  }
}

/** Validate an immutable Git commit supplied by the release workflow. */
export function validateCommitSha(commit) {
  if (!COMMIT_SHA_PATTERN.test(commit)) {
    throw new Error(`expected a 40-character release commit SHA, received "${commit}"`)
  }
  return commit.toLowerCase()
}

/**
 * Decide how a rolling branch may move without ever rewinding or switching to
 * unrelated history.
 */
export function decideBranchUpdate({
  currentCommit,
  targetCommit,
  currentIsAncestorOfTarget = false,
  targetIsAncestorOfCurrent = false,
}) {
  if (!currentCommit) return 'create'
  if (currentCommit === targetCommit) return 'unchanged'
  if (currentIsAncestorOfTarget && !targetIsAncestorOfCurrent) return 'fast-forward'
  if (targetIsAncestorOfCurrent && !currentIsAncestorOfTarget) {
    return 'stale'
  }
  if (currentIsAncestorOfTarget && targetIsAncestorOfCurrent) {
    throw new Error(`inconsistent ancestry reported for ${currentCommit} and ${targetCommit}`)
  }
  throw new Error(
    `refusing to move ${PROMOTION_BRANCH} from ${currentCommit} to divergent commit ${targetCommit}`,
  )
}

/** Build the stable-promotion PR fields shown to the releaser. */
export function createPromotionPrMetadata(betaTag) {
  const { stableVersion } = validateBetaTag(betaTag)
  return {
    base: PROMOTION_BASE_BRANCH,
    head: PROMOTION_BRANCH,
    title: `chore: promote ${betaTag} to stable ${stableVersion}`,
    body: [
      `Promotes the exact published beta snapshot \`${betaTag}\` from \`${DEVELOPMENT_BRANCH}\` to \`${PROMOTION_BASE_BRANCH}\`.`,
      '',
      'Merging this PR is the single human approval for the stable release. The release workflow will finalize the stable version and changelog, then publish the desktop and TestFlight builds.',
      '',
      '**Merge with “Create a merge commit”. Do not squash or rebase this PR.** A merge commit preserves the development history shared by the release branches.',
    ].join('\n'),
  }
}

/** Validate the owner/name repository identifier supplied by GitHub Actions. */
export function validateGitHubRepository(repository) {
  if (!GITHUB_REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`expected GITHUB_REPOSITORY to contain owner/name, received "${repository}"`)
  }
  return repository
}

/** Build `gh pr create` arguments for the rolling promotion PR. */
export function createPromotionPrCreateArgs(metadata, repository) {
  return [
    'pr',
    'create',
    '--repo',
    validateGitHubRepository(repository),
    '--base',
    metadata.base,
    '--head',
    metadata.head,
    '--title',
    metadata.title,
    '--body',
    metadata.body,
  ]
}

/** Build `gh pr edit` arguments for an existing rolling promotion PR. */
export function createPromotionPrEditArgs({ metadata, number, repository }) {
  return [
    'pr',
    'edit',
    String(number),
    '--repo',
    validateGitHubRepository(repository),
    '--title',
    metadata.title,
    '--body',
    metadata.body,
  ]
}

/** Build `gh pr list` arguments including the repository-identity fields. */
export function createPromotionPrListArgs(repository) {
  return [
    'pr',
    'list',
    '--repo',
    validateGitHubRepository(repository),
    '--state',
    'open',
    '--base',
    PROMOTION_BASE_BRANCH,
    '--head',
    PROMOTION_BRANCH,
    '--json',
    'number,baseRefName,headRefName,headRepository,isCrossRepository',
    '--limit',
    '10',
  ]
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    encoding: 'utf8',
  })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(
    `git merge-base failed for ${ancestor} and ${descendant}${commandOutput(result) ? `: ${commandOutput(result)}` : ''}`,
  )
}

function remoteBranchCommit(branch) {
  const result = spawnSync(
    'git',
    ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`],
    { encoding: 'utf8' },
  )
  if (result.status === 2) return null
  if (result.status !== 0) {
    throw new Error(
      `could not read origin/${branch}${commandOutput(result) ? `: ${commandOutput(result)}` : ''}`,
    )
  }

  const commit = result.stdout.trim().split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`origin/${branch} returned an invalid commit: ${result.stdout.trim()}`)
  }
  return commit
}

function fetchReleaseRefs(betaTag) {
  run('git', [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${DEVELOPMENT_BRANCH}:refs/remotes/origin/${DEVELOPMENT_BRANCH}`,
    `+refs/heads/${PROMOTION_BASE_BRANCH}:refs/remotes/origin/${PROMOTION_BASE_BRANCH}`,
  ])
  run('git', ['fetch', '--force', 'origin', `refs/tags/${betaTag}:refs/tags/${betaTag}`])
}

function fetchPromotionBranch() {
  run('git', [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${PROMOTION_BRANCH}:refs/remotes/origin/${PROMOTION_BRANCH}`,
  ])
}

/** Parse `gh pr list` output and retain only this repository's managed PR. */
export function parseManagedPromotionPrNumbers(output, repository) {
  const expectedRepository = validateGitHubRepository(repository).toLowerCase()
  let pullRequests
  try {
    pullRequests = JSON.parse(output)
  } catch {
    throw new Error('gh returned invalid JSON while listing promotion PRs')
  }
  if (!Array.isArray(pullRequests)) {
    throw new Error('gh returned a non-array while listing promotion PRs')
  }

  return pullRequests.flatMap((pullRequest, index) => {
    if (
      !pullRequest ||
      typeof pullRequest !== 'object' ||
      !Number.isSafeInteger(pullRequest.number) ||
      pullRequest.number <= 0 ||
      typeof pullRequest.baseRefName !== 'string' ||
      typeof pullRequest.headRefName !== 'string' ||
      typeof pullRequest.isCrossRepository !== 'boolean' ||
      (pullRequest.headRepository !== null &&
        (typeof pullRequest.headRepository !== 'object' ||
          typeof pullRequest.headRepository.nameWithOwner !== 'string'))
    ) {
      throw new Error(`gh returned an invalid promotion PR at index ${index}`)
    }

    const headRepository = pullRequest.headRepository?.nameWithOwner.toLowerCase()
    const isManaged =
      !pullRequest.isCrossRepository &&
      headRepository === expectedRepository &&
      pullRequest.baseRefName === PROMOTION_BASE_BRANCH &&
      pullRequest.headRefName === PROMOTION_BRANCH
    return isManaged ? [pullRequest.number] : []
  })
}

function openPromotionPrNumbers(repository) {
  const output = capture('gh', createPromotionPrListArgs(repository))
  return parseManagedPromotionPrNumbers(output, repository)
}

function updatePromotionPr(number, metadata, repository) {
  run('gh', createPromotionPrEditArgs({ metadata, number, repository }))
  log(`updated promotion PR #${number} for ${metadata.title}`)
}

function createOrUpdatePromotionPr(metadata, repository) {
  const existing = openPromotionPrNumbers(repository)
  if (existing.length > 1) {
    throw new Error(`found multiple open promotion PRs: ${existing.map((number) => `#${number}`).join(', ')}`)
  }
  if (existing.length === 1) {
    updatePromotionPr(existing[0], metadata, repository)
    return
  }

  const create = spawnSync('gh', createPromotionPrCreateArgs(metadata, repository), {
    encoding: 'utf8',
  })
  if (create.status === 0) {
    log(`opened promotion PR${create.stdout.trim() ? `: ${create.stdout.trim()}` : ''}`)
    return
  }

  // Another release workflow may have created the same rolling PR after the
  // initial lookup. GitHub rejects the duplicate; discover and update the
  // winning PR so both runs remain idempotent.
  const concurrent = openPromotionPrNumbers(repository)
  if (concurrent.length === 1) {
    updatePromotionPr(concurrent[0], metadata, repository)
    return
  }
  throw new Error(
    `could not create the promotion PR${commandOutput(create) ? `: ${commandOutput(create)}` : ''}`,
  )
}

function updatePromotionBranch(betaTag, expectedCommit) {
  fetchReleaseRefs(betaTag)

  const betaCommit = capture('git', ['rev-parse', `${betaTag}^{commit}`])
  if (betaCommit !== expectedCommit) {
    throw new Error(`${betaTag} moved from verified release commit ${expectedCommit} to ${betaCommit}`)
  }
  if (!isAncestor(betaCommit, `origin/${DEVELOPMENT_BRANCH}`)) {
    throw new Error(`${betaTag} (${betaCommit}) is not on origin/${DEVELOPMENT_BRANCH}`)
  }
  if (isAncestor(betaCommit, `origin/${PROMOTION_BASE_BRANCH}`)) {
    log(`${betaTag} (${betaCommit}) is already contained in origin/${PROMOTION_BASE_BRANCH}`)
    return 'already-promoted'
  }
  if (!isAncestor(`origin/${PROMOTION_BASE_BRANCH}`, betaCommit)) {
    throw new Error(`origin/${PROMOTION_BASE_BRANCH} is not an ancestor of ${betaTag} (${betaCommit})`)
  }

  const currentCommit = remoteBranchCommit(PROMOTION_BRANCH)
  if (currentCommit) fetchPromotionBranch()
  const decision = decideBranchUpdate({
    currentCommit,
    targetCommit: betaCommit,
    currentIsAncestorOfTarget: currentCommit ? isAncestor(currentCommit, betaCommit) : false,
    targetIsAncestorOfCurrent: currentCommit ? isAncestor(betaCommit, currentCommit) : false,
  })

  if (decision === 'stale') {
    log(`ignored stale promotion candidate ${betaTag} (${betaCommit}); ${PROMOTION_BRANCH} is newer`)
    return decision
  }
  if (decision !== 'unchanged') {
    run('git', ['push', 'origin', `${betaCommit}:refs/heads/${PROMOTION_BRANCH}`])
  }
  log(`${decision === 'unchanged' ? 'kept' : decision === 'create' ? 'created' : 'fast-forwarded'} ${PROMOTION_BRANCH} at ${betaTag} (${betaCommit})`)
  return decision
}

function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] === '--help') {
    const usage =
      'Usage: node apps/desktop/scripts/release-promotion.mjs <vX.Y.Z-beta[.N]> <commit-sha>'
    if (args[0] === '--help') {
      console.log(usage)
      return
    }
    throw new Error(usage)
  }

  const betaTag = args[0]
  validateBetaTag(betaTag)
  const expectedCommit = validateCommitSha(args[1])
  const decision = updatePromotionBranch(betaTag, expectedCommit)
  if (decision === 'stale' || decision === 'already-promoted') return
  const repository = validateGitHubRepository(process.env.GITHUB_REPOSITORY ?? '')
  createOrUpdatePromotionPr(createPromotionPrMetadata(betaTag), repository)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`release-promotion: error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
