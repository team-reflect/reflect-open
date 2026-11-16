// Release helpers that the desktop (`apps/tauri/scripts`) and iOS
// (`apps/ios/scripts`) build scripts share.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { exec } from 'tinyexec'

/** `tinyexec` options for a command that prints straight to the terminal. */
export const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit' } } as const

const SENTRY_DSN_PATTERN =
  /^https:\/\/[0-9a-f]{32}@o463484\.ingest\.us\.sentry\.io\/4511705649971200$/

export function log(message: string): void {
  console.log(`[release] ${message}`)
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

/** Official builds must report to the production Sentry project or not at all. */
export function assertSentryDsn(): void {
  // The app trims the value before it parses it.
  const dsn = (process.env.VITE_SENTRY_DSN ?? '').trim()
  if (dsn && !SENTRY_DSN_PATTERN.test(dsn)) {
    throw new Error('VITE_SENTRY_DSN is not the production Reflect Sentry project')
  }
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

export interface Certificate {
  /** The `.p12` file, base64. */
  readonly content: string | undefined
  readonly password: string | undefined
}

/**
 * Imports `certificate` into a temporary keychain and calls `action` with the
 * keychain path. Without the certificate, calls `action` with `null`, and the
 * login keychain is used.
 */
export async function runWithSigningKeychain(
  tempDir: string,
  { content, password: certificatePassword }: Certificate,
  action: (keychain: string | null) => Promise<void>,
): Promise<void> {
  if (!content || !certificatePassword) {
    return await action(null)
  }
  const certificate = join(tempDir, 'certificate.p12')
  const keychain = join(tempDir, 'signing.keychain-db')
  const password = randomBytes(24).toString('hex')
  const searchList = await exec('security', ['list-keychains', '-d', 'user'], {
    throwOnError: true,
  })
  const previous = [...searchList.stdout.matchAll(/"([^"]+)"/g)].flatMap((match) => match[1] ?? [])
  writeFileSync(certificate, Buffer.from(content, 'base64'), { mode: 0o600 })
  const steps = [
    ['create-keychain', '-p', password, keychain],
    // Notarization and Rust builds can outlast the default five-minute auto-lock.
    ['set-keychain-settings', '-lut', '21600', keychain],
    ['unlock-keychain', '-p', password, keychain],
    ['list-keychains', '-d', 'user', '-s', keychain, ...previous],
    [
      'import',
      certificate,
      '-k',
      keychain,
      '-P',
      certificatePassword,
      '-T',
      '/usr/bin/codesign',
    ],
    [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ],
  ]
  try {
    for (const step of steps) {
      await exec('security', step, { throwOnError: true })
    }
    await action(keychain)
  } finally {
    await exec('security', ['list-keychains', '-d', 'user', '-s', ...previous])
    await exec('security', ['delete-keychain', keychain])
  }
}
