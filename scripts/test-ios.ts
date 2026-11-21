// Runs the tests of the iOS app in apps/ios in a new, slim simulator, so each
// run starts from an empty device. It prints the time of each step when the
// step ends.
//
//   pnpm test:ios
//
// In CI, IOS_SIMULATOR_SNAPSHOT is the folder of a simulator from
// `scripts/ios-simulator.ts prepare`, used instead of a new one.
//
// The result bundle and, after a failed test run, the log archive of the
// simulator go to apps/ios/build/test-ios.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { exec } from 'tinyexec'
import ms from 'pretty-ms'
import { createSimulator, restoreSimulator, slimSimulator } from './ios-simulator.ts'

const ROOT_DIR = join(import.meta.dirname, '..')
const BUILD_DIR = join(ROOT_DIR, 'apps', 'ios', 'build')
const DERIVED_DATA_DIR = join(BUILD_DIR, 'DerivedData')
const OUTPUT_DIR = join(BUILD_DIR, 'test-ios')
const RESULT_BUNDLE = join(OUTPUT_DIR, 'Reflect.xcresult')
const LOG_ARCHIVE = join(OUTPUT_DIR, 'simulator.logarchive')

const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true'
const SNAPSHOT_DIR = process.env.IOS_SIMULATOR_SNAPSHOT

async function run(command: string, args: string[]): Promise<void> {
  await exec(command, args, {
    throwOnError: true,
    nodeOptions: { cwd: ROOT_DIR, stdio: 'inherit' },
  })
}

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

async function main(): Promise<void> {
  // xcodebuild and `log collect` refuse to write over an existing bundle.
  rmSync(OUTPUT_DIR, { recursive: true, force: true })
  mkdirSync(OUTPUT_DIR, { recursive: true })

  await step('Build the web app', async () => {
    await run('pnpm', ['build:web:ios'])
  })

  await step('Build the Rust core', async () => {
    await run('pnpm', ['build:ffi:iphonesimulator'])
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
    await run('xcodebuild', [
      '-resolvePackageDependencies',
      '-onlyUsePackageVersionsFromResolvedFile',
      ...projectArgs,
    ])
  })

  const simulator = await step('Create the simulator', async () => {
    const udid = SNAPSHOT_DIR
      ? await restoreSimulator(SNAPSHOT_DIR)
      : await createSimulator(`reflect-test-${Date.now()}`)
    console.log(`[test-ios] simulator ${udid}`)
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
      await run('xcodebuild', ['build-for-testing', '-showBuildTimingSummary', ...xcodebuildArgs])
    })

    // simslim keeps its settings on the host, not in the device folder, so a
    // restored simulator needs it too.
    await step('Slim and boot the simulator', async () => {
      await slimSimulator(simulator)
    })

    await step('Launch Safari', async () => {
      await run('xcrun', ['simctl', 'launch', simulator, 'com.apple.mobilesafari'])
    })

    await step('Quit Safari', async () => {
      await run('xcrun', ['simctl', 'terminate', simulator, 'com.apple.mobilesafari'])
    })

    try {
      await step('Run the tests', async () => {
        await run('xcodebuild', [
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
    // A CI runner is discarded after the job, with its simulators.
    if (!IN_GITHUB_ACTIONS) {
      // `shutdown` fails when the simulator never booted, which is fine.
      await step('Shut down the simulator', async () => {
        await exec('xcrun', ['simctl', 'shutdown', simulator], {
          nodeOptions: { stdio: 'inherit' },
        })
      })

      await step('Delete the simulator', async () => {
        await run('xcrun', ['simctl', 'delete', simulator])
      })
    }

    console.log(`[test-ios] results: ${OUTPUT_DIR}`)
  }
}

await main()
