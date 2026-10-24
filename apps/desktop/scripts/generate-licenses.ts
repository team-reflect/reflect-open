// Regenerates `src/lib/licenses/licenses.gen.json`, the data behind
// Settings → Open Source Licenses.
//
// Needs cargo-about on the PATH:
// `cargo install --locked cargo-about@0.9.2 --features cli`

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'tinyexec'
import { z } from 'zod'

const APP_DIR = join(import.meta.dirname, '..')
const ROOT_DIR = join(APP_DIR, '..', '..')
const OUTPUT = join(APP_DIR, 'src', 'lib', 'licenses', 'licenses.gen.json')

interface Entry {
  name: string
  ecosystem: 'npm' | 'cargo' | 'other'
  license: string
  url: string | undefined
  /** Empty when the package ships no license file. */
  texts: string[]
}

const PnpmLicensesSchema = z.record(
  z.string(),
  z.array(
    z.object({
      name: z.string(),
      paths: z.array(z.string()),
      license: z.string(),
      homepage: z.string().optional(),
    }),
  ),
)

async function collectNpm(): Promise<Entry[]> {
  const { stdout } = await exec(
    'pnpm',
    ['--filter', '@reflect/desktop...', 'licenses', 'list', '--json', '--prod'],
    { throwOnError: true, nodeOptions: { cwd: ROOT_DIR } },
  )
  const entries: Entry[] = []
  for (const [license, packages] of Object.entries(PnpmLicensesSchema.parse(JSON.parse(stdout)))) {
    for (const pkg of packages) {
      // One path per installed version.
      for (const dir of pkg.paths) {
        entries.push({
          name: pkg.name,
          ecosystem: 'npm',
          license,
          url: pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`,
          texts: readNpmLicenses(dir),
        })
      }
    }
  }
  return entries
}

/**
 * Every LICENSE, COPYING, and NOTICE file the package ships, sorted by file
 * name. `.spdx` files hold SPDX metadata, not license text.
 */
function readNpmLicenses(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => /^(?:licen[cs]e|copying|notice)(?:\.|-|$)/i.test(file))
    .filter((file) => !file.endsWith('.spdx'))
    .toSorted()
    .map((file) => readFileSync(join(dir, file), 'utf8').trim())
}

const CargoAboutSchema = z.object({
  licenses: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      used_by: z.array(
        z.object({
          crate: z.object({
            name: z.string(),
            repository: z.string().nullish(),
          }),
        }),
      ),
    }),
  ),
})

async function collectCargo(): Promise<Entry[]> {
  // Reads `about.toml` at the repo root. `--fail` exits non-zero when a crate's
  // license cannot be determined.
  const { stdout } = await exec('cargo', ['about', 'generate', '--format', 'json', '--fail'], {
    throwOnError: true,
    nodeOptions: { cwd: ROOT_DIR },
  })
  return CargoAboutSchema.parse(JSON.parse(stdout)).licenses.flatMap((license) => {
    return license.used_by.map(({ crate }) => ({
      name: crate.name,
      ecosystem: 'cargo' as const,
      license: license.id,
      url: crate.repository ?? `https://crates.io/crates/${crate.name}`,
      texts: [license.text.trim()],
    }))
  })
}

/** The bundled Inter font, which comes from neither npm nor crates.io. */
function collectInter(): Entry {
  return {
    name: 'Inter',
    ecosystem: 'other',
    license: 'OFL-1.1',
    url: 'https://github.com/rsms/inter',
    texts: [
      readFileSync(
        join(ROOT_DIR, 'design-system', 'assets', 'fonts', 'LICENSE.txt'),
        'utf8',
      ).trim(),
    ],
  }
}

/**
 * One entry per package, without versions, so that upgrading a dependency
 * does not change the output unless its license changes. Several installed
 * versions merge into one entry, and so do the per-license entries
 * cargo-about reports for an `AND` expression. Licenses and URLs are sorted,
 * so the output does not depend on the tools' order.
 */
function mergeEntries(entries: Entry[]): Entry[] {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    const key = `${entry.ecosystem}:${entry.name}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return [...groups.values()].map((group) => ({
    ...group[0]!,
    url: group
      .map((entry) => entry.url)
      .filter((url) => url !== undefined)
      .toSorted()[0],
    license: [...new Set(group.map((entry) => entry.license))].toSorted().join(' AND '),
    texts: [...new Set(group.flatMap((entry) => entry.texts))],
  }))
}

function compareEntries(a: Entry, b: Entry): number {
  return (
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    a.ecosystem.localeCompare(b.ecosystem)
  )
}

/** The shortest key length. 4 base64url characters hold 24 bits. */
const MIN_KEY_LENGTH = 4

/**
 * Maps each text to its key: the shortest prefix of its base64url SHA-256,
 * at least `MIN_KEY_LENGTH` characters, that no other hash starts with. A new
 * text changes only the keys that share such a prefix with it. The map is
 * sorted by key.
 */
function keyTexts(texts: string[]): Map<string, string> {
  const hashed = texts
    .map((text) => ({ text, hash: createHash('sha256').update(text).digest('base64url') }))
    .toSorted((a, b) => (a.hash < b.hash ? -1 : 1))
  // In sorted order, the longest prefix a hash shares with any other hash is
  // the one it shares with a neighbor.
  return new Map(
    hashed.map(({ text, hash }, i) => {
      const length = Math.max(
        MIN_KEY_LENGTH,
        countCommonPrefix(hash, hashed[i - 1]?.hash ?? '') + 1,
        countCommonPrefix(hash, hashed[i + 1]?.hash ?? '') + 1,
      )
      return [text, hash.slice(0, length)]
    }),
  )
}

function countCommonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return i
}

async function main(): Promise<void> {
  const collected = [...(await collectNpm()), ...(await collectCargo()), collectInter()]
  const entries = mergeEntries(collected).toSorted(compareEntries)

  // Each distinct text is stored once under its key, and entries refer to
  // texts by key.
  const keys = keyTexts([...new Set(entries.flatMap((entry) => entry.texts))])

  const data = {
    entries: entries.map((entry) => ({
      ...entry,
      texts: entry.texts.map((text) => keys.get(text)!).toSorted(),
    })),
    texts: Object.fromEntries([...keys].map(([text, key]) => [key, text] as const)),
  }
  writeFileSync(OUTPUT, JSON.stringify(data, null, 2))
  console.log(`[licenses] ${entries.length} entries → ${OUTPUT}`)
}

await main()
