import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const workflowPath = join(
  scriptsDirectory,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'release-please.yml',
)
const workflow = readFileSync(workflowPath, 'utf8')
const retryWorkflowPath = join(
  scriptsDirectory,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'retry-release-please.yml',
)
const retryWorkflow = readFileSync(retryWorkflowPath, 'utf8')

test('new releases wait for draft visibility before delivery', () => {
  const resultStepStart = workflow.indexOf('- name: Collect release-please outputs')
  const resultStepEnd = workflow.indexOf('- name: Print release-please outputs')
  const resultStep = workflow.slice(resultStepStart, resultStepEnd)

  expect(resultStepStart).toBeGreaterThan(-1)
  expect(resultStepEnd).toBeGreaterThan(resultStepStart)
  expect(resultStep).toContain('if [ "$release_created" = "true" ]; then')
  expect(resultStep).toContain('release_lookup_args=(--wait-for-visible "$tag_name")')
  expect(resultStep).toContain(
    'find-github-release.sh "${release_lookup_args[@]}"',
  )
})

test('a published beta retry resumes TestFlight and promotion without rebuilding macOS', () => {
  const publishReleaseStart = workflow.indexOf('  publish-release:')
  const postStableStart = workflow.indexOf('  post-stable:')
  const betaDeliveryJobs = workflow.slice(publishReleaseStart, postStableStart)

  expect(publishReleaseStart).toBeGreaterThan(-1)
  expect(postStableStart).toBeGreaterThan(publishReleaseStart)
  expect(betaDeliveryJobs).toContain(
    "(github.ref_name == 'next' && needs.release-please.outputs.release_available == 'true')",
  )
  expect(betaDeliveryJobs).toContain('always() &&')
  expect(betaDeliveryJobs).toContain("needs.publish-testflight.result == 'success'")
  expect(betaDeliveryJobs).toContain(
    "needs.release-please.outputs.release_created == 'true' &&\n        needs.publish-release.result == 'success'",
  )
  expect(betaDeliveryJobs).toContain(
    "needs.release-please.outputs.release_created == 'false' &&\n        needs.publish-release.result == 'skipped'",
  )
})

test('a beta retry only recovers release state for its immutable commit', () => {
  const resultStepStart = workflow.indexOf('- name: Collect release-please outputs')
  const resultStepEnd = workflow.indexOf('- name: Print release-please outputs')
  const resultStep = workflow.slice(resultStepStart, resultStepEnd)

  expect(resultStep).toContain(
    'elif [ "$BRANCH_NAME" = "next" ] && [ "$RUN_ATTEMPT" -gt 1 ]; then',
  )
  expect(resultStep).toContain('if [ "$branch_head" != "$GITHUB_SHA" ]; then')
  expect(resultStep).toContain('.target_commitish == $commit')
  expect(resultStep).toContain('.draft == true and .published_at == null and .prerelease == true')
  expect(resultStep).toContain('recovered_beta_release=true')
  expect(resultStep).toContain(
    'if [ "$recovered_beta_release" = "true" ] && [ "$release_commit" != "$GITHUB_SHA" ]; then',
  )
  expect(resultStep).not.toContain(
    'if [ "$BRANCH_NAME" = "next" ] && [ "$release_commit" != "$GITHUB_SHA" ]; then',
  )
})

test('failed release maintenance gets two bounded automatic retries', () => {
  expect(retryWorkflow).toContain('workflow_run:')
  expect(retryWorkflow).toContain('workflows: [Release PR]')
  expect(retryWorkflow).toContain('types: [completed]')
  expect(retryWorkflow).toContain('actions: write')
  expect(retryWorkflow).toContain(
    "github.event.workflow_run.conclusion == 'failure' &&\n      github.event.workflow_run.run_attempt < 3",
  )
  expect(retryWorkflow).toContain(
    'actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}/jobs?per_page=100',
  )
  expect(retryWorkflow).toContain('.name == "Maintain the Release PR"')
  expect(retryWorkflow).toContain('.conclusion == "failure"')
  expect(retryWorkflow).toContain(
    'current_attempt="$(jq -r \'.run_attempt\' <<< "$current_run")"',
  )
  expect(retryWorkflow).toContain(
    '[ "$current_attempt" != "$RUN_ATTEMPT" ] || [ "$current_status" != "completed" ]',
  )
  expect(retryWorkflow).toContain(
    'gh api --method POST "repos/${GITHUB_REPOSITORY}/actions/jobs/${JOB_ID}/rerun"',
  )
  expect(retryWorkflow).not.toContain('rerun-failed-jobs')
})
