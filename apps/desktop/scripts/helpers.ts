import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyMergePatch } from 'tiny-merge-patch'
import { exec } from 'tinyexec'
import { z } from 'zod'

export const APP_DIR = join(import.meta.dirname, '..')
export const ROOT_DIR = join(APP_DIR, '..', '..')
export const TAURI_SRC_DIR = join(APP_DIR, 'src-tauri')

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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const PackageJsonSchema = z.object({ version: z.string().min(1) })

/** The app version from `apps/desktop/package.json`, the single version source. */
export function readAppVersion(): string {
  return PackageJsonSchema.parse(readJson(join(APP_DIR, 'package.json'))).version
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
export function resolveFlavor(version: string): Flavor {
  return version.includes('-') ? 'beta' : 'stable'
}

/** The `--config` arguments that select a flavor. The base config is the stable flavor. */
export function getFlavorConfigArgs(flavor: Flavor): string[] {
  const overlay = FLAVOR_OVERLAYS[flavor]
  return overlay ? ['--config', join('src-tauri', overlay)] : []
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
    if (file) {
      config = applyMergePatch(config, readJson(join(TAURI_SRC_DIR, file)))
    }
  }
  return TauriConfigSchema.parse(config)
}

const CargoMetadataSchema = z.object({ target_directory: z.string() })

/** The Cargo target directory of the workspace. */
export async function getCargoTargetDir(): Promise<string> {
  const { stdout } = await exec('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    throwOnError: true,
    nodeOptions: { cwd: ROOT_DIR },
  })
  return CargoMetadataSchema.parse(JSON.parse(stdout)).target_directory
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
  if (!APPLE_API_KEY || !APPLE_API_ISSUER) {
    return null
  }
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

/** The Apple ID and app-specific password from `APPLE_ID` and `APPLE_PASSWORD`. */
export function resolveAppleId(): AppleId | null {
  const { APPLE_ID, APPLE_PASSWORD } = process.env
  return APPLE_ID && APPLE_PASSWORD ? { account: APPLE_ID, password: APPLE_PASSWORD } : null
}
