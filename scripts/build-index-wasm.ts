// Builds `crates/index-wasm` for `wasm32-unknown-unknown` and writes the
// JavaScript bindings to `packages/index-wasm/pkg`.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const outDir = path.join(root, 'packages/index-wasm/pkg')
const wasmPath = 'target/wasm32-unknown-unknown/wasm/reflect_index_wasm.wasm'

function read(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

function run(command: string, args: string[], env?: Record<string, string>): void {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
}

/**
 * The `llvm-ar` of the Rust toolchain. The C build of SQLite needs it: the
 * macOS `ar` writes an archive with no symbol index for wasm objects.
 */
function findLlvmAr(): string {
  const host = /^host: (.+)$/m.exec(read('rustc', ['-vV']))?.[1]
  if (host === undefined) {
    throw new Error('rustc -vV printed no host triple')
  }
  const extension = process.platform === 'win32' ? '.exe' : ''
  const sysroot = read('rustc', ['--print', 'sysroot'])
  return path.join(sysroot, 'lib/rustlib', host, 'bin', `llvm-ar${extension}`)
}

/**
 * Checks that the wasm-bindgen CLI has the version of the `wasm-bindgen`
 * crate: the CLI rejects the output of any other version.
 */
function checkWasmBindgenVersion(): void {
  const lock = readFileSync(path.join(root, 'Cargo.lock'), 'utf8')
  const wanted = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1]
  const installed = read('wasm-bindgen', ['--version']).split(' ')[1]
  if (wanted === undefined || installed !== wanted) {
    throw new Error(
      `The wasm-bindgen CLI is ${installed}, and Cargo.lock has the crate at ${wanted}. ` +
        `Run "mise install", or "cargo install --locked wasm-bindgen-cli --version ${wanted}".`,
    )
  }
}

// A job that downloaded `pkg` has no Rust toolchain. A build for a native
// shell (`TAURI_ENV_PLATFORM`) leaves the dev bridge out, and the wasm with it.
if (
  process.env['REFLECT_INDEX_WASM_PREBUILT'] !== undefined ||
  process.env['TAURI_ENV_PLATFORM'] !== undefined
) {
  process.exit(0)
}

checkWasmBindgenVersion()
run(
  'cargo',
  [
    'build',
    '--package',
    'reflect-index-wasm',
    '--target',
    'wasm32-unknown-unknown',
    '--profile',
    'wasm',
  ],
  { AR_wasm32_unknown_unknown: findLlvmAr() },
)
run('wasm-bindgen', [wasmPath, '--target', 'web', '--no-typescript', '--out-dir', outDir])
