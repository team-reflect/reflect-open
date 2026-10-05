import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { x } from 'tinyexec'
import { z } from 'zod'

export const appDir = join(import.meta.dirname, '..')
export const repoRoot = join(appDir, '..', '..')
export const tauriDir = join(appDir, 'src-tauri')

const STABLE_UPDATER_ENDPOINT =
  'https://github.com/team-reflect/reflect-open/releases/latest/download/latest.json'
const NOTARY_KEYCHAIN_SERVICE = 'reflect-notary'

export function log(message: string): void {
  console.log(`[release] ${message}`)
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string
}

/** Runs a command and returns its trimmed stdout. Throws with the captured output on failure. */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const output = await x(command, args, {
    nodeOptions: {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    },
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  })
  if (output.exitCode !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed\n${output.stdout}${output.stderr}`.trim())
  }
  return output.stdout.trim()
}

/** Runs a command with inherited stdio. Throws when it exits with a non-zero status. */
export async function exec(
  command: string,
  args: readonly string[],
  options: Omit<RunOptions, 'stdin'> = {},
): Promise<void> {
  const output = await x(command, args, {
    nodeOptions: { cwd: options.cwd, env: options.env, stdio: 'inherit' },
  })
  if (output.exitCode !== 0) throw new Error(`${command} ${args[0] ?? ''} failed`)
}

/** Runs the Tauri CLI through its JS entry point, so JSON `--config` values never pass through a shell. */
export async function tauri(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<void> {
  const cli = join(appDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  await exec(process.execPath, [cli, ...args], env ? { cwd: appDir, env } : { cwd: appDir })
}

/** Calls `action` with a temporary directory and removes the directory afterwards. */
export async function withTempDir<Result>(
  action: (dir: string) => Promise<Result>,
): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'reflect-release-'))
  try {
    return await action(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Runs a script entry point. A thrown error becomes a one-line message and exit code 1. */
export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (error) {
    console.error(`[release] error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The app version from `apps/desktop/package.json`, the single version source. */
export function readAppVersion(): string {
  return z.object({ version: z.string().min(1) }).parse(readJson(join(appDir, 'package.json')))
    .version
}

export type Flavor = 'stable' | 'beta' | 'dev'

const FLAVOR_OVERLAYS: Record<Flavor, string | null> = {
  stable: null,
  beta: 'tauri.beta.conf.json',
  dev: 'tauri.dev.conf.json',
}

/** Returns true when `value` names a build flavor. */
export function isFlavor(value: string): value is Flavor {
  return value in FLAVOR_OVERLAYS
}

/** A prerelease version builds the beta flavor, so a build always matches its updater feed. */
export function flavorOfVersion(version: string): Flavor {
  return version.includes('-') ? 'beta' : 'stable'
}

/**
 * The `--config` arguments that select a flavor. The base config commits the
 * beta updater endpoint, so the stable flavor pins the stable feed here.
 */
export function flavorConfigArgs(flavor: Flavor): string[] {
  const overlay = FLAVOR_OVERLAYS[flavor]
  if (overlay) return ['--config', join('src-tauri', overlay)]
  const endpoints = { plugins: { updater: { endpoints: [STABLE_UPDATER_ENDPOINT] } } }
  return ['--config', JSON.stringify(endpoints)]
}

/** Applies an RFC 7396 JSON Merge Patch, the algorithm Tauri uses for `--config`. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const merged: Record<string, unknown> =
    target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = mergePatch(merged[key], value)
  }
  return merged
}

const TauriConfigSchema = z.object({
  productName: z.string(),
  identifier: z.string(),
  bundle: z.object({
    externalBin: z.array(z.string()).default([]),
    macOS: z
      .object({
        entitlements: z.string().optional(),
        files: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
  }),
})

export type TauriConfig = z.infer<typeof TauriConfigSchema>

/** Resolves the config the way `tauri build` does: base, then platform file, then flavor overlay. */
export function readTauriConfig(platform: 'macos' | 'windows', flavor: Flavor): TauriConfig {
  const files = ['tauri.conf.json', `tauri.${platform}.conf.json`, FLAVOR_OVERLAYS[flavor]]
  let config: unknown = {}
  for (const file of files) {
    if (file) config = mergePatch(config, readJson(join(tauriDir, file)))
  }
  return TauriConfigSchema.parse(config)
}

/** The Cargo target directory of the workspace. */
export async function cargoTargetDir(): Promise<string> {
  const metadata = await run('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: repoRoot,
  })
  return z.object({ target_directory: z.string() }).parse(JSON.parse(metadata)).target_directory
}

/** Reads a generic password from the keychain, or null when the item does not exist. */
export async function keychainPassword(service: string): Promise<string | null> {
  const output = await x('security', ['find-generic-password', '-s', service, '-w'])
  return output.exitCode === 0 ? output.stdout.trim() : null
}

export interface ApiKey {
  readonly keyId: string
  readonly issuer: string
  /** Path to the `.p8` file, or null when only the standard search paths can provide it. */
  readonly keyPath: string | null
}

/**
 * The App Store Connect API key from `APPLE_API_KEY` and `APPLE_API_ISSUER`.
 * `APPLE_API_KEY_CONTENT` (raw or base64 `.p8` text) is written into `tempDir`.
 */
export function resolveApiKey(tempDir: string): ApiKey | null {
  const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_CONTENT, APPLE_API_KEY_PATH } = process.env
  if (!APPLE_API_KEY || !APPLE_API_ISSUER) return null
  if (!APPLE_API_KEY_CONTENT) {
    return { keyId: APPLE_API_KEY, issuer: APPLE_API_ISSUER, keyPath: APPLE_API_KEY_PATH ?? null }
  }
  const text = APPLE_API_KEY_CONTENT.includes('BEGIN PRIVATE KEY')
    ? APPLE_API_KEY_CONTENT
    : Buffer.from(APPLE_API_KEY_CONTENT, 'base64').toString('utf8')
  const keyPath = join(tempDir, `AuthKey_${APPLE_API_KEY}.p8`)
  writeFileSync(keyPath, `${text.trim()}\n`, { mode: 0o600 })
  return { keyId: APPLE_API_KEY, issuer: APPLE_API_ISSUER, keyPath }
}

export interface AppleId {
  readonly account: string
  readonly password: string
}

/** The Apple ID and app-specific password from the environment or the `reflect-notary` keychain item. */
export async function resolveAppleId(): Promise<AppleId | null> {
  const { APPLE_ID, APPLE_PASSWORD } = process.env
  if (APPLE_ID && APPLE_PASSWORD) return { account: APPLE_ID, password: APPLE_PASSWORD }
  const item = await x('security', ['find-generic-password', '-s', NOTARY_KEYCHAIN_SERVICE])
  const account = /"acct"<blob>="([^"]+)"/.exec(item.stdout)?.[1]
  const password = await keychainPassword(NOTARY_KEYCHAIN_SERVICE)
  return account && password ? { account, password } : null
}

/** Stores the notarization Apple ID in the keychain. `security` prompts for the password itself. */
export async function storeAppleId(account: string): Promise<void> {
  await exec('security', [
    'add-generic-password',
    '-U',
    '-s',
    NOTARY_KEYCHAIN_SERVICE,
    '-a',
    account,
    '-w',
  ])
}
