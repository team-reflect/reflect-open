import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptsDirectory, '..', '..', '..')
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release-please.yml'), 'utf8')
const stableConfig = JSON.parse(
  readFileSync(join(repoRoot, '.github', 'release-please', 'config.stable.json'), 'utf8'),
)
const betaConfig = JSON.parse(
  readFileSync(join(repoRoot, '.github', 'release-please', 'config.beta.json'), 'utf8'),
)

test('the stable pass runs before the beta pass', () => {
  // The stable Release PR advances manifest.beta.json, so the push that
  // merges it must create the stable tag before the beta pass anchors on it.
  const stablePass = workflow.indexOf('config-file: .github/release-please/config.stable.json')
  const betaPass = workflow.indexOf('config-file: .github/release-please/config.beta.json')
  expect(stablePass).toBeGreaterThan(-1)
  expect(betaPass).toBeGreaterThan(stablePass)
})

test('the stable Release PR advances the beta manifest', () => {
  expect(stableConfig.packages['.']['extra-files']).toContainEqual({
    type: 'json',
    path: '.github/release-please/manifest.beta.json',
    jsonpath: "$['.']",
  })
})

test('the channels keep distinct release-please head branches', () => {
  // The component becomes part of the head branch name, and release creation
  // matches merged Release PRs by that component; identical components would
  // make the two passes overwrite each other's PR.
  expect(stableConfig.packages['.'].component).toBeUndefined()
  expect(stableConfig.packages['.']['package-name']).toBe('reflect-open')
  expect(betaConfig.packages['.'].component).toBe('reflect-open-beta')
})

test('both channels tag plain versions and draft their releases', () => {
  for (const config of [stableConfig, betaConfig]) {
    expect(config['include-component-in-tag']).toBe(false)
    expect(config.draft).toBe(true)
    expect(config['force-tag-creation']).toBe(true)
  }
  expect(betaConfig.versioning).toBe('prerelease')
  expect(betaConfig['prerelease-type']).toBe('beta')
  expect(stableConfig.versioning).toBeUndefined()
})

test('each channel chains its release into delivery', () => {
  for (const channel of ['stable', 'beta']) {
    expect(workflow).toContain(`${channel}_created: \${{ steps.${channel}.outputs.releases_created }}`)
    expect(workflow).toContain(`${channel}_tag: \${{ steps.${channel}.outputs.tag_name }}`)
    expect(workflow).toContain(`${channel}_commit: \${{ steps.${channel}.outputs.sha }}`)
    expect(workflow).toContain(`if: needs.release-please.outputs.${channel}_created == 'true'`)
    expect(workflow).toContain(`tag: \${{ needs.release-please.outputs.${channel}_tag }}`)
    expect(workflow).toContain(`commit: \${{ needs.release-please.outputs.${channel}_commit }}`)
  }
  expect(workflow).toContain('uses: ./.github/workflows/release.yml')
  expect(workflow).toContain('uses: ./.github/workflows/testflight.yml')
})

test('release runs queue instead of cancelling', () => {
  expect(workflow).toContain('group: release-please')
  expect(workflow).toContain('cancel-in-progress: false')
})
