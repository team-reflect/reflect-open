// Runs the tests of the iOS app in apps/ios the same way on a developer's Mac
// and in CI: in a simulator that it creates for this run, so each run starts
// from an empty device.
//
//   pnpm test:ios [--output <dir>] [--derived-data <dir>] [--skip-web] [--keep-simulator]
//
//   --output          Directory for the result bundle, the full xcodebuild logs and,
//                     after a failure, the simulator's log archive
//   --derived-data    Xcode's DerivedData directory
//   --skip-web        Use the web app that is already in apps/ios/Web
//   --keep-simulator  Leave the simulator in place after the run
//
// The Xcode build makes the Rust core when its slice is missing.

import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'

const ROOT_DIR = join(import.meta.dirname, '..')
const DEVICE_TYPE = 'iPhone 17'

/** `tinyexec` options for a command that prints straight to the terminal. */
const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit', cwd: ROOT_DIR } } as const

const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true'

function log(message: string): void {
  console.log(`[test-ios] ${message}`)
}

/** The name and the duration of each finished step, for the summary. */
const timings: Array<{ name: string; seconds: number }> = []

/** Runs one step: a log group in GitHub Actions, and a row in the summary. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  console.log(IN_GITHUB_ACTIONS ? `::group::${name}` : `\n[test-ios] ${name}`)
  const start = Date.now()
  try {
    return await run()
  } finally {
    timings.push({ name, seconds: Math.round((Date.now() - start) / 1000) })
    if (IN_GITHUB_ACTIONS) {
      console.log('::endgroup::')
    }
  }
}

/** The identifier of the newest installed iOS runtime that has `DEVICE_TYPE`. */
async function newestRuntime(): Promise<string> {
  const list = await exec('xcrun', ['simctl', 'list', 'runtimes', 'available', '--json'], {
    throwOnError: true,
  })
  const { runtimes } = JSON.parse(list.stdout) as {
    runtimes: Array<{
      platform: string
      version: string
      identifier: string
      supportedDeviceTypes: Array<{ name: string }>
    }>
  }
  const newest = runtimes
    .filter((runtime) => {
      return (
        runtime.platform === 'iOS' &&
        runtime.supportedDeviceTypes.some((device) => device.name === DEVICE_TYPE)
      )
    })
    .toSorted((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
    .at(-1)
  if (newest === undefined) {
    throw new Error(`no installed iOS runtime has the device type ${DEVICE_TYPE}`)
  }
  return newest.identifier
}

/**
 * Runs `xcodebuild` and writes its full output to `logFile`. With `xcbeautify`
 * installed, the terminal shows the short form of the output. Returns whether
 * `xcodebuild` succeeded.
 */
async function xcodebuild(args: string[], logFile: string): Promise<boolean> {
  const hasXcbeautify = (await exec('which', ['xcbeautify'])).exitCode === 0
  const renderer = IN_GITHUB_ACTIONS ? ' --renderer github-actions' : ''
  const printer = hasXcbeautify ? `xcbeautify${renderer}` : 'cat'
  const result = await exec(
    'bash',
    ['-c', `set -o pipefail; xcodebuild "$@" 2>&1 | tee "$LOG_FILE" | ${printer}`, 'bash', ...args],
    {
      nodeOptions: {
        stdio: 'inherit',
        cwd: ROOT_DIR,
        env: { ...process.env, LOG_FILE: logFile },
      },
    },
  )
  return result.exitCode === 0
}

function printSummary(): void {
  const rows = timings.map(({ name, seconds }) => `| ${name} | ${seconds} s |`)
  const table = ['| Step | Time |', '| --- | ---: |', ...rows].join('\n')
  console.log(`\n${table}`)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath !== undefined && summaryPath !== '') {
    appendFileSync(summaryPath, `${table}\n`)
  }
}

async function main(): Promise<void> {
  const defaultDir = join(tmpdir(), 'reflect-test-ios')
  const { values } = parseArgs({
    options: {
      output: { type: 'string', default: join(defaultDir, 'results') },
      'derived-data': { type: 'string', default: join(defaultDir, 'DerivedData') },
      'skip-web': { type: 'boolean', default: false },
      'keep-simulator': { type: 'boolean', default: false },
    },
  })
  const outputDir = values.output
  const resultBundle = join(outputDir, 'Reflect.xcresult')
  const logArchive = join(outputDir, 'simulator.logarchive')
  mkdirSync(outputDir, { recursive: true })
  // xcodebuild and `log collect` refuse to write over an existing bundle.
  rmSync(resultBundle, { recursive: true, force: true })
  rmSync(logArchive, { recursive: true, force: true })

  if (!values['skip-web']) {
    await step('Build the web app', async () => {
      await exec('pnpm', ['--filter', '@reflect/ios', 'build:web'], INHERIT)
    })
  }

  const simulator = await step('Create the simulator', async () => {
    const name = `reflect-test-${Date.now()}`
    const runtime = await newestRuntime()
    const created = await exec('xcrun', ['simctl', 'create', name, DEVICE_TYPE, runtime], {
      throwOnError: true,
    })
    const udid = created.stdout.trim()
    log(`created ${name} (${udid}) on ${runtime}`)
    return udid
  })

  const xcodebuildArgs = [
    '-project',
    'apps/ios/Reflect.xcodeproj',
    '-scheme',
    'Reflect',
    '-configuration',
    'Debug-Dev',
    '-destination',
    `platform=iOS Simulator,id=${simulator}`,
    '-derivedDataPath',
    values['derived-data'],
  ]

  let passed = false
  try {
    // The build comes before the boot: a booted simulator takes CPU time
    // from the compiler.
    await step('Build the app and the tests', async () => {
      const built = await xcodebuild(
        ['build-for-testing', ...xcodebuildArgs],
        join(outputDir, 'build.log'),
      )
      if (!built) {
        throw new Error(`the build failed; full log: ${join(outputDir, 'build.log')}`)
      }
    })

    await step('Boot the simulator', async () => {
      await exec('xcrun', ['simctl', 'bootstatus', simulator, '-b'], INHERIT)
      // A new simulator still starts system services after `bootstatus`
      // returns. The first launch of an app is the slowest one: Safari takes it.
      await sleep(10_000)
      await exec('xcrun', ['simctl', 'launch', simulator, 'com.apple.mobilesafari'], INHERIT)
      await exec('xcrun', ['simctl', 'terminate', simulator, 'com.apple.mobilesafari'], INHERIT)
    })

    passed = await step('Run the tests', () => {
      return xcodebuild(
        ['test-without-building', ...xcodebuildArgs, '-resultBundlePath', resultBundle],
        join(outputDir, 'test.log'),
      )
    })

    if (!passed) {
      await step('Collect the log of the simulator', async () => {
        const collect = await exec(
          'xcrun',
          ['simctl', 'spawn', simulator, 'log', 'collect', '--last', '30m', '--output', logArchive],
          { nodeOptions: { stdio: 'inherit' } },
        )
        if (collect.exitCode !== 0) {
          log('the log archive is not available')
        }
      })
    }
  } finally {
    if (values['keep-simulator']) {
      log(`kept the simulator ${simulator}`)
    } else {
      await exec('xcrun', ['simctl', 'delete', simulator], { nodeOptions: { stdio: 'inherit' } })
    }
    printSummary()
  }

  log(`result bundle: ${resultBundle}`)
  if (!passed) {
    log(`log archive: ${logArchive}`)
    log('open the result bundle in Xcode for the screenshots and the steps of each test')
    process.exitCode = 1
  }
}

await main()
