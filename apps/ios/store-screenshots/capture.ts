// Takes the raw screens of the App Store screenshots in the simulator:
// `raw/<device>/<theme>/<screen>.png`.
//
// The simulators run one at a time: a booted simulator takes the CPU from the
// others, so parallel runs are slower in total and their screens less stable.
// Each device has its own simulator, `reflect-store-<device>`, kept between
// runs so the next run skips the first boot.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exec } from 'tinyexec'

import { DEVICES, THEMES, type Device, type DeviceName } from './devices.ts'
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

/**
 * Builds `duo-close.m` for the simulator, once. It runs inside the simulator,
 * so it needs the iOS Simulator SDK and an ad-hoc signature.
 */
async function buildDuoClose(): Promise<string> {
  const binary = join(OUT_DIR, 'duo-close')
  if (!existsSync(binary)) {
    await run('xcrun', [
      '-sdk',
      'iphonesimulator',
      'clang',
      '-arch',
      'arm64',
      '-mios-simulator-version-min=17.0',
      '-fobjc-arc',
      '-framework',
      'IOKit',
      '-framework',
      'Foundation',
      '-o',
      binary,
      join(import.meta.dirname, 'duo-close.m'),
    ])
    await run('codesign', ['-f', '-s', '-', binary])
  }
  return binary
}

/** The simulator of `device`, made on first use. */
async function simulator(device: DeviceName): Promise<{ udid: string; booted: boolean }> {
  const name = `reflect-store-${device}`
  const { devices } = JSON.parse(await simctl('list', 'devices', '--json')) as {
    devices: Record<string, { name: string; udid: string; state: string; isAvailable: boolean }[]>
  }
  const found = Object.values(devices)
    .flat()
    .find((entry) => entry.name === name && entry.isAvailable)
  if (found) {
    return { udid: found.udid, booted: found.state === 'Booted' }
  }
  const type = `com.apple.CoreSimulator.SimDeviceType.${DEVICES[device].simulator}`
  return { udid: await simctl('create', name, type), booted: false }
}

/**
 * Sets the preferences of the shut-down simulator `udid` that its status bar
 * and its windows read at boot. `plutil` writes the files directly: `defaults`
 * goes through the cache of the Mac's preferences daemon, which the
 * simulator does not read.
 */
async function prepare(udid: string): Promise<void> {
  const dir = join(
    homedir(),
    'Library/Developer/CoreSimulator/Devices',
    udid,
    'data/Library/Preferences',
  )
  const springboard = join(dir, 'com.apple.springboard.plist')
  if (!existsSync(springboard)) {
    // The first boot writes the files.
    await simctl('bootstatus', udid, '-b')
    await simctl('shutdown', udid)
  }
  const global = join(dir, '.GlobalPreferences.plist')
  // The US format, "Fri Nov 20", whatever the region of the Mac.
  await run('plutil', ['-replace', 'AppleLocale', '-string', 'en_US', global])
  await run('plutil', ['-replace', 'AppleLanguages', '-json', '["en-US"]', global])
  // Full Screen Apps on iPad: no window corner and no app name in the status bar.
  await run('plutil', ['-replace', 'SBMedusaMultitaskingEnabled', '-bool', 'false', springboard])
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

  const { udid, booted } = await simulator(device)
  if (booted) {
    await simctl('shutdown', udid)
  }
  await prepare(udid)
  try {
    // Boots the simulator when it is shut down, and waits for the boot.
    await simctl('bootstatus', udid, '-b')
    // Two overrides: with the other flags in the same call, the iPad shows
    // a wrong weekday next to the date.
    await simctl(
      'status_bar',
      udid,
      'override',
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
      // `charged` draws a charging bolt.
      'discharging',
      '--batteryLevel',
      '100',
    )
    const { canvas, closed } = DEVICES[device] as Device
    if (closed) {
      await simctl('spawn', udid, await buildDuoClose())
    }
    // simctl takes only this ISO form; the status bar shows local 9:41.
    await simctl(
      'status_bar',
      udid,
      'override',
      '--time',
      new Date(`${today}T09:41:00`).toISOString(),
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
          TEST_RUNNER_STORE_SCREENSHOTS_LANDSCAPE: String(canvas[0] > canvas[1]),
        },
      )
    }
  } finally {
    await simctl('shutdown', udid)
  }
}
