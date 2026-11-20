// The simulator of `pnpm test:ios`.
//
//   node scripts/ios-simulator.ts prepare <dir>
//
// CI only: creates a slim simulator, waits until the work of its first boot
// ends, shuts it down and moves it to <dir> for the cache.

import { mkdirSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { exec } from 'tinyexec'

const DEVICES_DIR = join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices')

async function run(command: string, args: string[]): Promise<string> {
  const result = await exec(command, args, {
    throwOnError: true,
    nodeOptions: { stdio: ['ignore', 'pipe', 'inherit'] },
  })
  return result.stdout.trim()
}

export async function createSimulator(name: string): Promise<string> {
  return await run('xcrun', ['simctl', 'create', name, 'iPhone 17'])
}

/**
 * Turns off the background services that the tests do not need, then boots the
 * simulator once.
 */
export async function slimSimulator(udid: string): Promise<void> {
  await ensureSimulator(udid)
  // The app listens to StoreKit transactions.
  await exec('simslim', ['on', udid, '--keep', 'com.apple.storekitd'], {
    throwOnError: true,
    nodeOptions: {
      stdio: 'inherit',
      env: { ...process.env, SIMSLIM_BOOT_TIMEOUT: '15m', SIMSLIM_SPAWN_TIMEOUT: '5m' },
    },
  })
  await run('xcrun', ['simctl', 'bootstatus', udid, '-b'])
}

/** Moves the simulator that `prepare` saved in `dir` back into the device set. */
export async function restoreSimulator(dir: string): Promise<string> {
  const [udid] = readdirSync(dir)
  if (!udid) {
    throw new Error(`No simulator in ${dir}`)
  }
  renameSync(join(dir, udid), join(DEVICES_DIR, udid))
  await restartCoreSimulator()
  await ensureSimulator(udid)
  return udid
}

/** Makes CoreSimulator read the device folders again. */
async function restartCoreSimulator(): Promise<void> {
  await exec('killall', ['-9', 'com.apple.CoreSimulator.CoreSimulatorService'])
}

interface SimctlDevice {
  udid: string
  isAvailable: boolean
  availabilityError?: string
}

/** Returns the entry of the simulator in `simctl list`, with its runtime. */
async function findSimulator(
  udid: string,
): Promise<{ runtime: string; device: SimctlDevice } | undefined> {
  const { devices } = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', '--json'])) as {
    devices: Record<string, SimctlDevice[]>
  }
  for (const [runtime, list] of Object.entries(devices)) {
    const device = list.find((entry) => entry.udid === udid)
    if (device) {
      return { runtime, device }
    }
  }
  return undefined
}

/**
 * Returns whether CoreSimulator lists the simulator as available within a
 * minute. When it does not, prints what CoreSimulator lists.
 */
async function waitForSimulator(udid: string): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    if ((await findSimulator(udid))?.device.isAvailable) {
      return true
    }
    await sleep(1000)
  }
  console.log(`[ios-simulator] simulator ${udid} is not available:`)
  console.log(JSON.stringify((await findSimulator(udid)) ?? 'not listed', null, 2))
  console.log(await run('xcrun', ['simctl', 'list', 'runtimes']))
  return false
}

/** Waits until the simulator is available, restarting CoreSimulator once. */
async function ensureSimulator(udid: string): Promise<void> {
  if (await waitForSimulator(udid)) {
    return
  }
  console.log('[ios-simulator] restarting CoreSimulator')
  await restartCoreSimulator()
  if (!(await waitForSimulator(udid))) {
    throw new Error(`Simulator ${udid} is not available`)
  }
}

// The log daemon and the push daemon use about 0.4 of a core in every booted
// simulator.
const ALWAYS_BUSY = new Set(['diagnosticd', 'apsd'])

/** Returns the CPU seconds that each simulator process has used, by PID. */
async function simulatorCpu(): Promise<Map<string, number>> {
  const cpu = new Map<string, number>()
  for (const line of (await run('ps', ['-A', '-o', 'pid=,time=,comm='])).split('\n')) {
    const [pid = '', time = '', ...rest] = line.trim().split(/\s+/)
    const command = rest.join(' ')
    if (
      (command.includes('/CoreSimulator/') || command.includes('RuntimeRoot')) &&
      !ALWAYS_BUSY.has(basename(command))
    ) {
      // [[hours:]minutes:]seconds
      cpu.set(
        pid,
        time.split(':').reduce((total, part) => total * 60 + Number(part), 0),
      )
    }
  }
  return cpu
}

/**
 * Returns when the simulator used under half a core over the last 3 minutes, or
 * after 10 minutes. Adapted from
 * https://github.com/apoorvdarshan/scowld/blob/3137e6ebbf61f35dfe34ba2330f653814d339619/scripts/ci/ios_simulator.py#L123-L162
 */
async function waitForIdle(): Promise<void> {
  const started = Date.now()
  const samples: { cpu: number; seconds: number }[] = []
  let previous = await simulatorCpu()
  let previousTime = started
  while (Date.now() - started < 600_000) {
    await sleep(15_000)
    const current = await simulatorCpu()
    const now = Date.now()
    let cpu = 0
    for (const [pid, seconds] of current) {
      cpu += seconds - (previous.get(pid) ?? 0)
    }
    samples.push({ cpu, seconds: (now - previousTime) / 1000 })
    if (samples.length > 12) {
      samples.shift()
    }
    previous = current
    previousTime = now
    const cores =
      samples.reduce((sum, sample) => sum + sample.cpu, 0) /
      samples.reduce((sum, sample) => sum + sample.seconds, 0)
    console.log(
      `[ios-simulator] ${Math.round((now - started) / 1000)} s: ${cores.toFixed(2)} cores`,
    )
    if (samples.length === 12 && cores < 0.5) {
      return
    }
  }
}

async function prepare(dir: string): Promise<void> {
  const udid = await createSimulator('reflect-test')
  await slimSimulator(udid)
  await waitForIdle()
  await run('xcrun', ['simctl', 'shutdown', udid])
  mkdirSync(dir, { recursive: true })
  renameSync(join(DEVICES_DIR, udid), join(dir, udid))
}

if (import.meta.main) {
  const [command, dir] = process.argv.slice(2)
  if (command !== 'prepare' || !dir) {
    throw new Error('Usage: node scripts/ios-simulator.ts prepare <dir>')
  }
  await prepare(dir)
}
