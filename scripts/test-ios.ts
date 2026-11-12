// Runs the tests of the iOS app in apps/ios the same way on a developer's Mac
// and in CI: in a new simulator for each run, so each run starts from an empty
// device. It prints the time of each step when the step ends.
//
//   pnpm test:ios
//
// The result bundle and, after a failed test run, the log archive of the
// simulator go to apps/ios/build/test-ios.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { exec } from 'tinyexec'
import ms from 'pretty-ms'

const ROOT_DIR = join(import.meta.dirname, '..')
const BUILD_DIR = join(ROOT_DIR, 'apps', 'ios', 'build')
const DERIVED_DATA_DIR = join(BUILD_DIR, 'DerivedData')
const OUTPUT_DIR = join(BUILD_DIR, 'test-ios')
const RESULT_BUNDLE = join(OUTPUT_DIR, 'Reflect.xcresult')
const LOG_ARCHIVE = join(OUTPUT_DIR, 'simulator.logarchive')

const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true'

/** Runs a command that prints straight to the terminal and throws when it fails. */
async function run(command: string, args: string[]): Promise<void> {
  await exec(command, args, {
    throwOnError: true,
    nodeOptions: { cwd: ROOT_DIR, stdio: 'inherit' },
  })
}

/** Runs one step and prints its time when it ends. */
async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  console.log(IN_GITHUB_ACTIONS ? `::group::${name}` : `\n[test-ios] ${name}`)
  const start = Date.now()
  try {
    return await body()
  } finally {
    if (IN_GITHUB_ACTIONS) {
      console.log('::endgroup::')
    }
    const duration = Date.now() - start
    console.log(`[test-ios] ${name}: ${ms(duration)}`)
  }
}

/** Runs `xcodebuild`, through `xcbeautify` when it is installed. */
async function xcodebuild(args: string[]): Promise<void> {
  const renderer = IN_GITHUB_ACTIONS ? '--renderer github-actions' : ''
  const script = `
    set -o pipefail
    if command -v xcbeautify >/dev/null; then
      xcodebuild "$@" 2>&1 | xcbeautify ${renderer}
    else
      xcodebuild "$@"
    fi`
  await run('bash', ['-c', script, 'bash', ...args])
}

async function main(): Promise<void> {
  // xcodebuild and `log collect` refuse to write over an existing bundle.
  rmSync(OUTPUT_DIR, { recursive: true, force: true })
  mkdirSync(OUTPUT_DIR, { recursive: true })

  await step('Build the web app', async () => {
    await run('pnpm', ['--filter', '@reflect/ios', 'build:web'])
  })

  await step('Build the Rust core', async () => {
    await run('pnpm', ['build:ffi', '--debug', '--sdk', 'iphonesimulator'])
  })

  const projectArgs = [
    '-project',
    'apps/ios/Reflect.xcodeproj',
    '-scheme',
    'Reflect',
    '-derivedDataPath',
    DERIVED_DATA_DIR,
  ]

  await step('Resolve the Swift packages', async () => {
    await xcodebuild(['-resolvePackageDependencies', ...projectArgs])
  })

  const simulator = await step('Create the simulator', async () => {
    const name = `reflect-test-${Date.now()}`
    const created = await exec('xcrun', ['simctl', 'create', name, 'iPhone 17'], {
      throwOnError: true,
    })
    const udid = created.stdout.trim()
    console.log(`[test-ios] created ${name} (${udid})`)
    return udid
  })

  const xcodebuildArgs = [
    ...projectArgs,
    '-configuration',
    'Debug-Dev',
    '-destination',
    `platform=iOS Simulator,id=${simulator}`,
  ]

  try {
    // The build comes before the boot: a booted simulator takes CPU time
    // from the compiler.
    await step('Build the app and the tests', async () => {
      await xcodebuild(['build-for-testing', ...xcodebuildArgs])
    })

    await step('Boot the simulator', async () => {
      await run('xcrun', ['simctl', 'bootstatus', simulator, '-b'])
    })

    // A new simulator still starts system services after `bootstatus` returns.
    await step('Wait for the system services', async () => {
      await sleep(10_000)
    })

    await step('Launch Safari', async () => {
      await run('xcrun', ['simctl', 'launch', simulator, 'com.apple.mobilesafari'])
    })

    await step('Quit Safari', async () => {
      await run('xcrun', ['simctl', 'terminate', simulator, 'com.apple.mobilesafari'])
    })

    try {
      await step('Run the tests', async () => {
        await xcodebuild([
          'test-without-building',
          ...xcodebuildArgs,
          '-resultBundlePath',
          RESULT_BUNDLE,
        ])
      })
    } catch (error) {
      // A failed collection leaves the test failure as the reported error.
      await step('Collect the log of the simulator', async () => {
        await exec(
          'xcrun',
          [
            'simctl',
            'spawn',
            simulator,
            'log',
            'collect',
            '--last',
            '30m',
            '--output',
            LOG_ARCHIVE,
          ],
          { nodeOptions: { stdio: 'inherit' } },
        )
      })
      throw error
    }
  } finally {
    // `shutdown` fails when the simulator never booted, which is fine.
    await step('Shut down the simulator', async () => {
      await exec('xcrun', ['simctl', 'shutdown', simulator], { nodeOptions: { stdio: 'inherit' } })
    })

    await step('Delete the simulator', async () => {
      await run('xcrun', ['simctl', 'delete', simulator])
    })

    console.log(`[test-ios] results: ${OUTPUT_DIR}`)
  }
}

await main()
