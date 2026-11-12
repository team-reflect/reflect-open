// Runs the iOS app in apps/ios in the "iPhone 17" simulator with the web app
// from the Vite dev server, so changes to the web app reload in place.
//
//   pnpm dev:ios
//
// It starts the dev server (or uses the one on port 1420), boots the
// simulator, builds the Debug-Dev app, installs it and launches it with
// `REFLECT_DEV_URL`. A change to Swift or Rust code needs a new run.
//
// The build goes to a directory in the system's temporary directory, which
// macOS removes after some days without access.

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { exec } from 'tinyexec'

const ROOT_DIR = join(import.meta.dirname, '..')
const DERIVED_DATA_DIR = join(tmpdir(), 'reflect-dev-ios', 'DerivedData')
const APP_PATH = join(
  DERIVED_DATA_DIR,
  'Build',
  'Products',
  'Debug-Dev-iphonesimulator',
  'Reflect.app',
)
const BUNDLE_ID = 'app.reflect.ios.dev'
const DEVICE_NAME = 'iPhone 17'
const DEV_URL = 'http://localhost:1420'

async function run(command: string, args: string[], env?: Record<string, string>): Promise<void> {
  await exec(command, args, {
    throwOnError: true,
    nodeOptions: { cwd: ROOT_DIR, stdio: 'inherit', env: { ...process.env, ...env } },
  })
}

async function isServing(): Promise<boolean> {
  try {
    const response = await fetch(DEV_URL)
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(): Promise<void> {
  while (!(await isServing())) {
    await sleep(500)
  }
}

interface SimDevice {
  udid: string
  name: string
  state: string
}

/**
 * Returns the UDID of the simulator named `DEVICE_NAME`: the booted one, else
 * the one on the newest runtime.
 */
async function findSimulator(): Promise<string> {
  const list = await exec('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    throwOnError: true,
  })
  const { devices } = JSON.parse(list.stdout) as { devices: Record<string, SimDevice[]> }
  const matches = Object.entries(devices)
    .sort(([a], [b]) => b.localeCompare(a, 'en', { numeric: true }))
    .flatMap(([, runtimeDevices]) => runtimeDevices.filter((device) => device.name === DEVICE_NAME))
  const device = matches.find((match) => match.state === 'Booted') ?? matches[0]
  if (!device) {
    throw new Error(`no available simulator named "${DEVICE_NAME}"; create one in Xcode`)
  }
  return device.udid
}

async function main(): Promise<void> {
  if (await isServing()) {
    console.log(`[dev-ios] using the dev server on ${DEV_URL}`)
  } else {
    console.log('[dev-ios] starting the dev server')
    const server = exec('pnpm', ['--filter', '@reflect/ios', 'dev:web'], {
      nodeOptions: { cwd: ROOT_DIR, stdio: 'inherit' },
    })
    process.on('exit', () => server.kill())
  }

  const simulator = await findSimulator()
  console.log(`[dev-ios] booting ${DEVICE_NAME} (${simulator})`)
  await run('xcrun', ['simctl', 'bootstatus', simulator, '-b'])
  // Only shows the window; the app runs without it.
  const opened = await exec('open', ['-a', 'Simulator'])
  if (opened.exitCode !== 0) {
    console.log('[dev-ios] Simulator.app did not open; the simulator runs without a window')
  }

  // The app bundles apps/ios/Web (a link to apps/web/dist/mobile). The build
  // needs the folder, but this run loads the dev server.
  mkdirSync(join(ROOT_DIR, 'apps', 'web', 'dist', 'mobile'), { recursive: true })

  console.log('[dev-ios] building the app')
  await run('xcodebuild', [
    '-project',
    'apps/ios/Reflect.xcodeproj',
    '-scheme',
    'Reflect',
    '-configuration',
    'Debug-Dev',
    '-destination',
    `platform=iOS Simulator,id=${simulator}`,
    '-derivedDataPath',
    DERIVED_DATA_DIR,
    'build',
  ])

  await run('xcrun', ['simctl', 'install', simulator, APP_PATH])
  await waitForServer()
  // simctl passes each `SIMCTL_CHILD_*` variable to the app without the prefix.
  await run('xcrun', ['simctl', 'launch', '--terminate-running-process', simulator, BUNDLE_ID], {
    SIMCTL_CHILD_REFLECT_DEV_URL: DEV_URL,
  })
  console.log(`[dev-ios] the app loads ${DEV_URL}; press Ctrl-C to stop`)
}

await main()
