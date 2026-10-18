// Regenerates `src/lib/licenses/licenses.gen.json`, the data behind
// Settings → Open Source Licenses.
//
// Needs cargo-about on the PATH:
// `cargo install --locked cargo-about@0.9.2 --features cli`

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'tinyexec'
import { z } from 'zod'

const APP_DIR = join(import.meta.dirname, '..')
const ROOT_DIR = join(APP_DIR, '..', '..')
const OUTPUT = join(APP_DIR, 'src', 'lib', 'licenses', 'licenses.gen.json')

interface Entry {
  name: string
  version: string
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
      versions: z.array(z.string()),
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
      for (const [index, version] of pkg.versions.entries()) {
        const dir = pkg.paths[index] ?? pkg.paths[0]!
        entries.push({
          name: pkg.name,
          version,
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
            version: z.string(),
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
  return CargoAboutSchema.parse(JSON.parse(stdout)).licenses.flatMap((license) =>
    license.used_by.map(({ crate }) => ({
      name: crate.name,
      version: crate.version,
      ecosystem: 'cargo' as const,
      license: license.id,
      url: crate.repository ?? `https://crates.io/crates/${crate.name}`,
      texts: [license.text.trim()],
    })),
  )
}

/** The bundled Inter font, which comes from neither npm nor crates.io. */
function collectInter(): Entry {
  return {
    name: 'Inter',
    version: '4.0',
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
 * One entry per package version. cargo-about lists a crate once under each
 * license of an `AND` expression, so those entries merge into one. Licenses
 * and texts are sorted, so the output does not depend on the tools' order.
 */
function mergeEntries(entries: Entry[]): Entry[] {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    const key = `${entry.ecosystem}:${entry.name}@${entry.version}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return [...groups.values()].map((group) => ({
    ...group[0]!,
    license: [...new Set(group.map((entry) => entry.license))].toSorted().join(' AND '),
    texts: [...new Set(group.flatMap((entry) => entry.texts))].toSorted(),
  }))
}

function compareEntries(a: Entry, b: Entry): number {
  return (
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    a.ecosystem.localeCompare(b.ecosystem) ||
    a.version.localeCompare(b.version, 'en', { numeric: true })
  )
}

async function main(): Promise<void> {
  const collected = [...(await collectNpm()), ...(await collectCargo()), collectInter()]
  const entries = mergeEntries(collected).toSorted(compareEntries)

  // Each distinct text is stored once; entries refer to texts by index.
  const texts = [...new Set(entries.flatMap((entry) => entry.texts))].toSorted()
  const textIndex = new Map(texts.map((text, index) => [text, index]))

  const data = {
    schemaVersion: 1,
    entries: entries.map((entry) => ({
      ...entry,
      texts: entry.texts.map((text) => textIndex.get(text)!),
    })),
    texts,
  }
  writeFileSync(OUTPUT, JSON.stringify(data, null, 2))
  console.log(`[licenses] ${entries.length} entries → ${OUTPUT}`)
}

await main()
