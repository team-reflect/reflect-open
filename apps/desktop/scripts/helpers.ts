import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { exec } from 'tinyexec'
import packageJson from '../package.json' with { type: 'json' }

export const APP_DIR = join(import.meta.dirname, '..')
const ROOT_DIR = join(APP_DIR, '..', '..')
export const TAURI_SRC_DIR = join(APP_DIR, 'src-tauri')
export const TARGET_DIR = join(ROOT_DIR, 'target')

const IOS_BUILD_DIR = join(TAURI_SRC_DIR, 'gen', 'apple', 'build')
export const IOS_ARCHIVE_PATH = join(IOS_BUILD_DIR, 'reflect-open_iOS.xcarchive')
export const IOS_IPA_PATH = join(IOS_BUILD_DIR, 'arm64', 'Reflect.ipa')

/** `tinyexec` options for a command that prints straight to the terminal. */
export const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit' } } as const

const BETA_OVERLAY = 'tauri.beta.conf.json'
const SENTRY_DSN_PATTERN =
  /^https:\/\/[0-9a-f]{32}@o463484\.ingest\.us\.sentry\.io\/4511705649971200$/

export function log(message: string): void {
  console.log(`[release] ${message}`)
}

/** Runs the Tauri CLI with inherited stdio. `env` is added to the current environment. */
export async function runTauri(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await exec(join(APP_DIR, 'node_modules', '.bin', 'tauri'), args, {
    throwOnError: true,
    nodeOptions: { cwd: APP_DIR, env, stdio: 'inherit' },
  })
}

/** Calls `action` with a temporary directory and removes the directory afterwards. */
export async function runWithTempDir<Result>(
  action: (dir: string) => Promise<Result>,
): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'reflect-release-'))
  try {
    return await action(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Copies each existing file and its updater signature (`.sig`) into
 * `artifactDir` under the name it is published with: GitHub stores a space in
 * an asset name as a dot.
 */
export function exportArtifacts(paths: readonly string[], artifactDir: string): void {
  mkdirSync(artifactDir, { recursive: true })
  for (const path of paths.flatMap((path) => [path, `${path}.sig`])) {
    if (existsSync(path)) {
      copyFileSync(path, join(artifactDir, basename(path).replaceAll(' ', '.')))
    }
  }
}

/** Official builds must report to the production Sentry project or not at all. */
export function assertSentryDsn(): void {
  // The app trims the value before it parses it.
  const dsn = (process.env.VITE_SENTRY_DSN ?? '').trim()
  if (dsn && !SENTRY_DSN_PATTERN.test(dsn)) {
    throw new Error('VITE_SENTRY_DSN is not the production Reflect Sentry project')
  }
}

/**
 * The Tauri config overlay of the flavor to build, or null for the stable
 * flavor (the base config). A prerelease version builds the beta flavor, so a
 * build always matches its updater feed.
 */
export function getFlavorOverlay(): string | null {
  return packageJson.version.includes('-') ? BETA_OVERLAY : null
}

/** The `--config` arguments that select the flavor. */
export function getFlavorConfigArgs(): string[] {
  const overlay = getFlavorOverlay()
  return overlay ? ['--config', join('src-tauri', overlay)] : []
}

/**
 * The Rust target triple of this machine, for example `aarch64-apple-darwin`,
 * `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, or `x86_64-unknown-linux-gnu`.
 */
export async function getHostTriple(): Promise<string> {
  const { stdout } = await exec('rustc', ['--print', 'host-tuple'], { throwOnError: true })
  return stdout.trim()
}

/** The Mach-O UUIDs of binaries or dSYMs, sorted and joined. */
async function readUuids(paths: readonly string[]): Promise<string> {
  const { stdout } = await exec('xcrun', ['dwarfdump', '--uuid', ...paths], { throwOnError: true })
  return [...stdout.matchAll(/^UUID: ([0-9A-F-]{36})/gim)]
    .map((match) => match[1])
    .toSorted()
    .join(',')
}

async function readSymbols(path: string): Promise<string> {
  return (await exec('xcrun', ['nm', '-j', path], { throwOnError: true })).stdout
}

/**
 * A crash report can only be symbolicated with the dSYMs of the exact shipped
 * executable. Checks that `binary` and `dsyms` have the same UUIDs, and that
 * every dSYM has `symbol` while `binary` no longer does.
 */
export async function assertDsyms(
  binary: string,
  dsyms: readonly string[],
  symbol: string,
): Promise<void> {
  const uuids = await readUuids([binary])
  if (!uuids || uuids !== (await readUuids(dsyms))) {
    throw new Error(`${basename(binary)} and its dSYMs do not have the same UUIDs`)
  }
  for (const dsym of dsyms) {
    const dwarfDir = join(dsym, 'Contents', 'Resources', 'DWARF')
    for (const name of readdirSync(dwarfDir)) {
      if (!(await readSymbols(join(dwarfDir, name))).includes(symbol)) {
        throw new Error(`${basename(dsym)} does not contain ${symbol}`)
      }
    }
  }
  if ((await readSymbols(binary)).includes(symbol)) {
    throw new Error(`${basename(binary)} still contains ${symbol}`)
  }
}

export interface ApiKey {
  readonly keyId: string
  readonly issuer: string
  readonly keyPath: string
}

/**
 * The App Store Connect API key from `APPLE_API_KEY` and `APPLE_API_ISSUER`.
 * The `.p8` file comes from `APPLE_API_KEY_PATH`, or `APPLE_API_KEY_CONTENT`
 * (raw or base64 text) is written into `tempDir`.
 */
export function resolveApiKey(tempDir: string): ApiKey | null {
  const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_CONTENT, APPLE_API_KEY_PATH } = process.env
  if (!APPLE_API_KEY || !APPLE_API_ISSUER) {
    return null
  }
  const key = { keyId: APPLE_API_KEY, issuer: APPLE_API_ISSUER }
  if (APPLE_API_KEY_PATH) {
    return { ...key, keyPath: APPLE_API_KEY_PATH }
  }
  if (!APPLE_API_KEY_CONTENT) {
    return null
  }
  const text = APPLE_API_KEY_CONTENT.includes('BEGIN PRIVATE KEY')
    ? APPLE_API_KEY_CONTENT
    : Buffer.from(APPLE_API_KEY_CONTENT, 'base64').toString('utf8')
  const keyPath = join(tempDir, `AuthKey_${APPLE_API_KEY}.p8`)
  writeFileSync(keyPath, `${text.trim()}\n`, { mode: 0o600 })
  return { ...key, keyPath }
}
