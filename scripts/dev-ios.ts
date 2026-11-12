// Runs the iOS app in apps/ios in a simulator with the web app from the Vite
// dev server, so changes to the web app reload in place.
//
//   pnpm dev:ios
//   pnpm dev:ios --device "iPhone 17 Pro"
//
// The simulator is "iPhone 17" unless `--device` names another one.
//
// It starts the dev server on port 1420, boots the simulator, builds the
// Debug-Dev app, installs it and launches it with `REFLECT_DEV_URL`. A change to Swift or Rust code needs a new run.
//
// The build goes to a directory in the system's temporary directory, which
// macOS removes after some days without access.

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { exec } from 'tinyexec'
import { z } from 'zod'

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
const DEV_URL = 'http://localhost:1420'

async function run(command: string, args: string[], env?: Record<string, string>): Promise<void> {
  await exec(command, args, {
    throwOnError: true,
    nodeOptions: { cwd: ROOT_DIR, stdio: 'inherit', env: { ...process.env, ...env } },
  })
}

async function isServing(): Promise<boolean> {
  try {
    const response = await fetch(DEV_URL, { signal: AbortSignal.timeout(1_000) })
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

/**
 * Starts the iOS dev server. The returned promise rejects when the server
 * exits, for example when another server holds port 1420.
 */
function startDevServer(): Promise<never> {
  const server = exec('pnpm', ['--filter', '@reflect/ios', 'dev:web'], {
    nodeOptions: { cwd: ROOT_DIR, stdio: 'inherit' },
  })
  process.on('exit', () => server.kill())
  return (async () => {
    await server
    throw new Error(`the dev server exited; check that no other server uses ${DEV_URL}`)
  })()
}

const SimctlDevices = z.object({
  devices: z.record(
    z.string(),
    z.array(z.object({ udid: z.string(), name: z.string(), state: z.string() })),
  ),
})

/**
 * Returns the UDID of the simulator named `deviceName`: the booted one, else
 * the one on the newest runtime.
 */
async function findSimulator(deviceName: string): Promise<string> {
  const list = await exec('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    throwOnError: true,
  })
  const { devices } = SimctlDevices.parse(JSON.parse(list.stdout))
  const available = Object.entries(devices)
    .sort(([runtimeA], [runtimeB]) => runtimeB.localeCompare(runtimeA, 'en', { numeric: true }))
    .flatMap(([, runtimeDevices]) => runtimeDevices)
  if (available.length === 0) {
    throw new Error('this Mac has no available simulators; add a simulator runtime in Xcode')
  }
  const matches = available.filter((device) => device.name === deviceName)
  const device = matches.find((match) => match.state === 'Booted') ?? matches[0]
  if (!device) {
    const names = [...new Set(available.map((simulator) => simulator.name))].sort()
    throw new Error(
      `no available simulator named "${deviceName}"; the available simulators are:\n` +
        names.map((name) => `  ${name}`).join('\n'),
    )
  }
  return device.udid
}

/**
 * Shows the window of the simulator. The simulator runs without it.
 */
async function openSimulatorWindow(simulator: string): Promise<void> {
  // Device Hub replaces Simulator.app in Xcode 27. It opens the window of a
  // device for this URL; `open` fails where no app handles the scheme.
  const deviceHub = await exec('open', [`devices://device/open?id=${simulator}`])
  if (deviceHub.exitCode === 0) {
    return
  }
  const simulatorApp = await exec('open', [
    '-b',
    'com.apple.iphonesimulator',
    '--args',
    '-CurrentDeviceUDID',
    simulator,
  ])
  if (simulatorApp.exitCode !== 0) {
    console.log('[dev-ios] found no app that shows the simulator; it runs without a window')
  }
}

async function buildAndLaunch(simulator: string, deviceName: string): Promise<void> {
  console.log(`[dev-ios] booting ${deviceName} (${simulator})`)
  await run('xcrun', ['simctl', 'bootstatus', simulator, '-b'])
  await openSimulatorWindow(simulator)

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { device: { type: 'string', default: 'iPhone 17' } },
  })
  const simulator = await findSimulator(values.device)
  // Always a server of its own: a server on port 1420 that this script did not
  // start can serve the desktop build.
  console.log('[dev-ios] starting the dev server')
  const serverExit = startDevServer()
  await Promise.race([buildAndLaunch(simulator, values.device), serverExit])
  await serverExit
}

await main()
