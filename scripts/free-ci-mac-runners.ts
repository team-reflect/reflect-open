// Cancels pull request CI runs that use a macOS runner while a master job
// waits for one, so that the macOS runners go to master. GitHub cancels a whole
// run, so re-run the pull request when master is done.
//
//   pnpm free-ci-mac-runners [--dry-run]

import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'

// Matches the `runs-on` labels of macOS runners, such as `macos-15` or `xcode-27`.
const MAC_LABEL = /^(?:macos|xcode)-/

interface Run {
  id: number
  event: string
  head_branch: string
  html_url: string
}

interface Job {
  status: string
  labels: string[]
}

async function listAll<Item>(path: string, key: string): Promise<Item[]> {
  const { stdout } = await exec('gh', ['api', '--paginate', '--slurp', path], {
    throwOnError: true,
  })
  const pages = JSON.parse(stdout) as Record<string, Item[]>[]
  return pages.flatMap((page) => page[key] ?? [])
}

async function listMacJobStatuses(run: Run): Promise<string[]> {
  const path = `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
  const jobs = await listAll<Job>(path, 'jobs')
  return jobs
    .filter((job) => job.labels.some((label) => MAC_LABEL.test(label)))
    .map((job) => job.status)
}

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } })

const runs = new Map<number, Run>()
for (const status of ['queued', 'in_progress']) {
  const path = `repos/{owner}/{repo}/actions/runs?status=${status}&per_page=100`
  for (const run of await listAll<Run>(path, 'workflow_runs')) runs.set(run.id, run)
}

let masterWaits = false
for (const run of runs.values()) {
  if (run.event === 'pull_request' || run.head_branch !== 'master') continue
  if ((await listMacJobStatuses(run)).includes('queued')) {
    console.log(`master waits for a macOS runner: ${run.html_url}`)
    masterWaits = true
  }
}

if (!masterWaits) {
  console.log('No master job waits for a macOS runner.')
  process.exit(0)
}

for (const run of runs.values()) {
  if (run.event !== 'pull_request') continue
  if ((await listMacJobStatuses(run)).some((status) => status !== 'completed')) {
    console.log(
      `${values['dry-run'] ? 'Would cancel' : 'Cancel'} (${run.head_branch}): ${run.html_url}`,
    )
    if (!values['dry-run']) {
      await exec('gh', [
        'api',
        '--silent',
        '-X',
        'POST',
        `repos/{owner}/{repo}/actions/runs/${run.id}/cancel`,
      ])
    }
  }
}
