// Takes the raw screens of the App Store screenshots in the simulator:
// `raw/<device>/<theme>/<screen>.png`.
//
// The simulators run one at a time: a booted simulator takes the CPU from the
// others, so parallel runs are slower in total and their screens less stable.
// Each device has its own simulator, `reflect-store-<device>`, kept between
// runs so the next run skips the first boot.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'tinyexec'

import { DEVICES, THEMES, type DeviceName } from './devices.ts'
import { storeFixture } from './fixture.ts'

const ROOT_DIR = join(import.meta.dirname, '..', '..', '..')
const OUT_DIR = join(import.meta.dirname, 'out')
export const RAW_DIR = join(OUT_DIR, 'raw')
const DERIVED_DATA_DIR = join(ROOT_DIR, 'apps', 'ios', 'build', 'DerivedData')

const PROJECT_ARGS = [
  '-project',
  'apps/ios/Reflect.xcodeproj',
  '-scheme',
  'Reflect',
  '-configuration',
  'Debug-Dev',
  '-derivedDataPath',
  DERIVED_DATA_DIR,
]

async function run(command: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await exec(command, args, {
    throwOnError: true,
    nodeOptions: {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'inherit'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    },
  })
  return result.stdout.trim()
}

const simctl = (...args: string[]) => run('xcrun', ['simctl', ...args])

/** Builds the web app, the Rust core, the app and its UI tests. */
export async function build(): Promise<void> {
  await run('pnpm', ['build:web:ios'])
  await run('pnpm', ['build:ffi:iphonesimulator'])
  await run('xcodebuild', [
    'build-for-testing',
    ...PROJECT_ARGS,
    '-destination',
    'generic/platform=iOS Simulator',
  ])
}

/** The UDID of the simulator of `device`, made on first use. */
async function simulator(device: DeviceName): Promise<string> {
  const name = `reflect-store-${device}`
  const { devices } = JSON.parse(await simctl('list', 'devices', '--json')) as {
    devices: Record<string, { name: string; udid: string; isAvailable: boolean }[]>
  }
  const found = Object.values(devices)
    .flat()
    .find((entry) => entry.name === name && entry.isAvailable)
  return (
    found?.udid ??
    (await simctl(
      'create',
      name,
      `com.apple.CoreSimulator.SimDeviceType.${DEVICES[device].simulator}`,
    ))
  )
}

/**
 * Takes every screen of `device` in both themes. `today` is the day of the
 * graph and of the status bar; the simulator has the clock of the Mac, so it
 * must be the Mac's local date.
 */
export async function capture(device: DeviceName, today: string): Promise<void> {
  const fixture = join(OUT_DIR, 'fixture.json')
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(fixture, storeFixture(today))

  const udid = await simulator(device)
  await simctl('boot', udid).catch(() => {}) // already booted
  try {
    await simctl('bootstatus', udid, '-b')
    await simctl(
      'status_bar',
      udid,
      'override',
      '--time',
      // simctl takes only this ISO form; the status bar shows local 9:41.
      new Date(`${today}T09:41:00`).toISOString(),
      '--dataNetwork',
      'wifi',
      '--wifiMode',
      'active',
      '--wifiBars',
      '3',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
    )
    for (const theme of THEMES) {
      const dir = join(RAW_DIR, device, theme)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      await simctl('ui', udid, 'appearance', theme)
      await run(
        'xcodebuild',
        [
          'test-without-building',
          ...PROJECT_ARGS,
          '-destination',
          `platform=iOS Simulator,id=${udid}`,
          '-only-testing:ReflectUITests/StoreScreenshotsUITests',
        ],
        {
          TEST_RUNNER_STORE_SCREENSHOTS_FIXTURE: fixture,
          TEST_RUNNER_STORE_SCREENSHOTS_DIR: dir,
        },
      )
    }
  } finally {
    await simctl('shutdown', udid)
  }
}
