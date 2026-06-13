// Bump the app version everywhere it lives and push the release tag.
//
// The version is declared in three places that must stay in lockstep:
//   - apps/desktop/src-tauri/tauri.conf.json  (what release-macos.mjs reads)
//   - apps/desktop/src-tauri/Cargo.toml       (the crate that gets compiled)
//   - Cargo.lock                              (the reflect-open entry)
// This script edits all three, commits, pushes the branch, then creates and
// pushes the `v<version>` tag — which is what triggers the Release workflow
// (.github/workflows/release.yml) to build, sign, notarize and publish.
//
// Usage:
//   pnpm release:bump                Cut the next beta (0.2.0-beta.1 → 0.2.0-beta.2)
//   pnpm release:bump beta           Same, explicit
//   pnpm release:bump stable         Drop the prerelease (0.2.0-beta.3 → 0.2.0)
//   pnpm release:bump patch|minor|major        Stable bump
//   pnpm release:bump prepatch|preminor|premajor  Open a new beta cycle (…-beta.1)
//   pnpm release:bump 0.5.0-beta.1   Set an explicit version
//
// Flags:
//   --dry-run   Show the plan and exit; touch nothing
//   --no-tag    Bump + commit + push the branch, but don't tag (no release)
//   --yes       Skip the confirmation prompt
//   --help
//
// Stable releases ship from `master`, betas from `next`; the script refuses to
// create a stable (non-prerelease) version while on `next` so a beta branch
// can't accidentally publish to the stable auto-update channel.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(here, '..', '..', '..')
const tauriConfPath = join(appDir, 'src-tauri', 'tauri.conf.json')
const cargoTomlPath = join(appDir, 'src-tauri', 'Cargo.toml')
const cargoLockPath = join(repoRoot, 'Cargo.lock')

/** The Cargo package whose version drives the release (and its lockfile entry). */
const CRATE = 'reflect-open'
/** The only prerelease identifier the app uses; bumped numerically. */
const PREID = 'beta'
/** Branches a release is normally cut from. */
const STABLE_BRANCH = 'master'
const BETA_BRANCH = 'next'

/** Named bump levels; anything else on the command line is an explicit version. */
const LEVELS = ['beta', 'stable', 'patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor']

function log(message) {
  console.log(`release-bump: ${message}`)
}

function fail(message) {
  console.error(`release-bump: error: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Version math — pure and exported so it can be unit-tested in isolation.
// ---------------------------------------------------------------------------

/**
 * Parse `MAJOR.MINOR.PATCH` with an optional `-prerelease` tail into its parts.
 * Throws on anything that isn't a well-formed semver core.
 */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version)
  if (!match) throw new Error(`"${version}" is not a MAJOR.MINOR.PATCH[-prerelease] version`)
  const [, major, minor, patch, prerelease] = match
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease: prerelease ?? null }
}

/** Render the parts produced by {@link parseVersion} back into a version string. */
export function formatVersion({ major, minor, patch, prerelease }) {
  const core = `${major}.${minor}.${patch}`
  return prerelease ? `${core}-${prerelease}` : core
}

/** Extract N from a `beta.N` prerelease, rejecting any other shape. */
function prereleaseNumber(prerelease) {
  const match = new RegExp(`^${PREID}\\.(\\d+)$`).exec(prerelease)
  if (!match) throw new Error(`prerelease "${prerelease}" is not "${PREID}.N" — pass an explicit version instead`)
  return Number(match[1])
}

/**
 * Compute the next version from `current` given a bump level or an explicit
 * target version. Pure: no I/O, throws (never exits) on invalid input so the
 * caller and the tests can handle errors uniformly.
 */
export function computeNextVersion(current, bump) {
  if (!LEVELS.includes(bump)) {
    // Not a level → treat as an explicit version target (validated by parsing).
    return formatVersion(parseVersion(bump))
  }
  const version = parseVersion(current)
  switch (bump) {
    case 'beta':
      if (!version.prerelease) {
        throw new Error(`${current} is already stable — use prepatch/preminor/premajor to open a new beta cycle`)
      }
      return formatVersion({ ...version, prerelease: `${PREID}.${prereleaseNumber(version.prerelease) + 1}` })
    case 'stable':
      if (!version.prerelease) throw new Error(`${current} is already stable`)
      return formatVersion({ ...version, prerelease: null })
    case 'patch':
      return formatVersion({ major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: null })
    case 'minor':
      return formatVersion({ major: version.major, minor: version.minor + 1, patch: 0, prerelease: null })
    case 'major':
      return formatVersion({ major: version.major + 1, minor: 0, patch: 0, prerelease: null })
    case 'prepatch':
      return formatVersion({ major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: `${PREID}.1` })
    case 'preminor':
      return formatVersion({ major: version.major, minor: version.minor + 1, patch: 0, prerelease: `${PREID}.1` })
    case 'premajor':
      return formatVersion({ major: version.major + 1, minor: 0, patch: 0, prerelease: `${PREID}.1` })
    default:
      throw new Error(`unhandled bump level "${bump}"`)
  }
}

// ---------------------------------------------------------------------------
// Git + filesystem side effects.
// ---------------------------------------------------------------------------

/** Run a git command in the repo, returning trimmed stdout; throws on failure. */
function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

/** Run a git command, returning { status, output } without throwing. */
function tryGit(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** The current branch name, or fail on a detached HEAD. */
function currentBranch() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') {
    fail(`detached HEAD — check out ${BETA_BRANCH} or ${STABLE_BRANCH} first`)
  }
  return branch
}

/** Read the current version from tauri.conf.json (the release source of truth). */
function readCurrentVersion() {
  return JSON.parse(readFileSync(tauriConfPath, 'utf8')).version
}

/**
 * Replace the single expected occurrence of `find` with `replace` in a file,
 * failing loudly if it appears zero or many times — a changed format should
 * stop the release, not silently skip or over-edit.
 */
function replaceOnce(path, find, replace, label) {
  const content = readFileSync(path, 'utf8')
  const occurrences = content.split(find).length - 1
  if (occurrences !== 1) {
    fail(`expected exactly one \`${find}\` in ${label}, found ${occurrences} — update release-bump.mjs`)
  }
  writeFileSync(path, content.replace(find, replace))
}

/** Edit all three version sites to `next` (from `current`). */
function writeVersion(current, next) {
  replaceOnce(tauriConfPath, `"version": "${current}"`, `"version": "${next}"`, 'tauri.conf.json')
  replaceOnce(cargoTomlPath, `version = "${current}"`, `version = "${next}"`, 'Cargo.toml')
  // cargo rewrites the lockfile's reflect-open entry from the new Cargo.toml.
  // --offline keeps it a pure version edit with no registry round-trip.
  const update = spawnSync('cargo', ['update', '-p', CRATE, '--offline'], { cwd: repoRoot, encoding: 'utf8' })
  if (update.status !== 0) {
    fail(`cargo update -p ${CRATE} failed (is cargo installed?):\n${update.stderr ?? ''}`)
  }
}

/** Confirm the destructive part of the run unless --yes was passed. */
async function confirm(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await readline.question(question)).trim().toLowerCase()
  readline.close()
  return answer === 'y' || answer === 'yes'
}

async function main() {
  const argv = process.argv.slice(2)
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const positionals = argv.filter((arg) => !arg.startsWith('--'))
  const knownFlags = ['--dry-run', '--no-tag', '--yes', '--help']
  const unknownFlag = flags.find((flag) => !knownFlags.includes(flag))
  if (unknownFlag) fail(`unknown flag "${unknownFlag}" — try --help`)
  if (positionals.length > 1) fail(`expected at most one level/version, got: ${positionals.join(' ')}`)
  if (flags.includes('--help')) {
    console.log(USAGE)
    return
  }

  const dryRun = flags.includes('--dry-run')
  const noTag = flags.includes('--no-tag')
  const skipPrompt = flags.includes('--yes')
  const bump = positionals[0] ?? 'beta'

  const current = readCurrentVersion()
  let next
  try {
    next = computeNextVersion(current, bump)
  } catch (error) {
    fail(error.message)
  }
  if (next === current) fail(`the new version equals the current one (${current}) — nothing to bump`)

  const branch = currentBranch()
  const isPrerelease = next.includes('-')
  const tag = `v${next}`

  // Guardrail: stable versions are for the stable channel, which ships from
  // master. A stable tag pushed from next would become `releases/latest` and
  // reach every stable install — refuse it here.
  if (!isPrerelease && branch === BETA_BRANCH) {
    fail(
      `refusing to cut stable ${next} from ${BETA_BRANCH}.\n` +
        `  Stable releases ship from ${STABLE_BRANCH}: merge ${BETA_BRANCH} → ${STABLE_BRANCH} and run this there.\n` +
        `  (To open the next beta cycle on ${BETA_BRANCH}, use prepatch/preminor/premajor.)`,
    )
  }

  if (git(['status', '--porcelain']) !== '') {
    fail('the working tree has uncommitted changes — commit or stash them first')
  }

  log('fetching origin…')
  const fetch = tryGit(['fetch', 'origin', branch, '--tags'])
  if (fetch.status !== 0) fail(`git fetch failed:\n${fetch.output.trim()}`)

  if (tryGit(['rev-parse', '--verify', `origin/${branch}`]).status !== 0) {
    fail(`origin/${branch} does not exist — push ${branch} first`)
  }
  if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', `origin/${branch}`])) {
    fail(
      `local ${branch} is not in sync with origin/${branch}.\n` +
        '  Pull or push so the release builds exactly the published code plus the version bump.',
    )
  }

  if (git(['tag', '--list', tag]) !== '') fail(`tag ${tag} already exists locally — bump to a new version`)
  if (git(['ls-remote', '--tags', 'origin', tag]) !== '') {
    fail(`tag ${tag} already exists on origin — bump to a new version`)
  }

  const releaseKind = isPrerelease ? 'pre-release' : 'release'
  log(`current version: ${current}`)
  log(`next version:    ${next}  (${bump})`)
  log(`branch:          ${branch}  (in sync with origin)`)
  log('plan:')
  console.log('  - update tauri.conf.json, Cargo.toml, Cargo.lock')
  console.log(`  - commit "Release ${tag}"`)
  console.log(`  - push ${branch} to origin`)
  if (noTag) {
    console.log('  - (skipping the tag — no release will be triggered)')
  } else {
    console.log(`  - tag ${tag} and push it → triggers the Release workflow (${releaseKind})`)
  }

  if (dryRun) {
    log('dry run — nothing changed')
    return
  }
  if (!skipPrompt && !(await confirm('Proceed? [y/N] '))) {
    log('aborted — nothing changed')
    return
  }

  writeVersion(current, next)
  git(['add', tauriConfPath, cargoTomlPath, cargoLockPath])
  git(['commit', '-m', `Release ${tag}`])

  log(`pushing ${branch} to origin…`)
  if (spawnSync('git', ['push', 'origin', `HEAD:${branch}`], { cwd: repoRoot, stdio: 'inherit' }).status !== 0) {
    fail('pushing the branch failed — resolve the issue and retry (nothing was tagged)')
  }

  if (noTag) {
    log(`bumped to ${next} and pushed ${branch} (no tag).`)
    log(`to release later: git tag ${tag} && git push origin ${tag}`)
    return
  }

  git(['tag', tag])
  log(`pushing tag ${tag}…`)
  if (spawnSync('git', ['push', 'origin', tag], { cwd: repoRoot, stdio: 'inherit' }).status !== 0) {
    fail(`pushing the tag failed — the branch is pushed; run \`git push origin ${tag}\` to trigger the release`)
  }
  log(`done — ${tag} pushed; the Release workflow will build & publish the ${releaseKind}.`)
  log('track it in GitHub → Actions → Release.')
}

const USAGE = `Usage: pnpm release:bump [level|version] [flags]

Levels:
  beta       (default) cut the next beta: 0.2.0-beta.1 → 0.2.0-beta.2
  stable     drop the prerelease:         0.2.0-beta.3 → 0.2.0
  patch      stable patch bump:           0.2.0 → 0.2.1
  minor      stable minor bump:           0.2.0 → 0.3.0
  major      stable major bump:           0.2.0 → 1.0.0
  prepatch   open a beta cycle:           0.2.0 → 0.2.1-beta.1
  preminor   open a beta cycle:           0.2.0 → 0.3.0-beta.1
  premajor   open a beta cycle:           0.2.0 → 1.0.0-beta.1
  <version>  set an explicit version, e.g. 0.5.0-beta.1

Flags:
  --dry-run   show the plan and exit; change nothing
  --no-tag    bump + commit + push the branch, but don't tag (no release)
  --yes       skip the confirmation prompt
  --help      show this help

Betas ship from ${BETA_BRANCH}; stable releases from ${STABLE_BRANCH}.
Docs: docs/macos-distribution.md`

// Only run when invoked directly (`node release-bump.mjs`), not when imported
// by the unit test — so importing the version math has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
