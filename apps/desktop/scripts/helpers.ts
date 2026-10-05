import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from 'tinyexec'
import { z } from 'zod'

export const APP_DIR = join(import.meta.dirname, '..')
export const ROOT_DIR = join(APP_DIR, '..', '..')
export const TAURI_SRC_DIR = join(APP_DIR, 'src-tauri')
export const TARGET_DIR = join(ROOT_DIR, 'target')

/** `tinyexec` options for a command that prints straight to the terminal. */
export const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit' } } as const

const BETA_OVERLAY = 'tauri.beta.conf.json'
const PackageJsonSchema = z.object({ version: z.string().min(1) })

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

/** The app version from `apps/desktop/package.json`, the single version source. */
export function readAppVersion(): string {
  const packageJson: unknown = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'))
  return PackageJsonSchema.parse(packageJson).version
}

/**
 * The Tauri config overlay of the flavor to build, or null for the stable
 * flavor (the base config). A prerelease version builds the beta flavor, so a
 * build always matches its updater feed.
 */
export function getFlavorOverlay(): string | null {
  return readAppVersion().includes('-') ? BETA_OVERLAY : null
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
