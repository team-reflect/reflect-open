import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { exec } from 'tinyexec'
import packageJson from '../../web/package.json' with { type: 'json' }

export const APP_DIR = join(import.meta.dirname, '..')
const ROOT_DIR = join(APP_DIR, '..', '..')
export const TARGET_DIR = join(ROOT_DIR, 'target')

const BETA_OVERLAY = 'tauri.beta.conf.json'

/** Runs the Tauri CLI with inherited stdio. `env` is added to the current environment. */
export async function runTauri(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await exec(join(APP_DIR, 'node_modules', '.bin', 'tauri'), args, {
    throwOnError: true,
    nodeOptions: { cwd: APP_DIR, env, stdio: 'inherit' },
  })
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
  return overlay ? ['--config', overlay] : []
}

/**
 * The Rust target triple of this machine, for example `aarch64-apple-darwin`,
 * `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, or `x86_64-unknown-linux-gnu`.
 */
export async function getHostTriple(): Promise<string> {
  const { stdout } = await exec('rustc', ['--print', 'host-tuple'], { throwOnError: true })
  return stdout.trim()
}
