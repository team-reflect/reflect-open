// Regenerates `src/lib/licenses/licenses.gen.json`, the data behind
// Settings → Open Source Licenses.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'tinyexec'
import { z } from 'zod'

const APP_DIR = join(import.meta.dirname, '..')
const ROOT_DIR = join(APP_DIR, '..', '..')
const OUTPUT = join(APP_DIR, 'src', 'lib', 'licenses', 'licenses.gen.json')

/** Licenses that ask for no notice. */
const NO_NOTICE = new Set(['0BSD', 'CC0-1.0', 'Unlicense'])

interface Entry {
  name: string
  version: string
  ecosystem: 'npm' | 'cargo' | 'other'
  license: string
  url: string | undefined
  /** Missing when the package ships no LICENSE file. */
  text: string | undefined
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
    if (NO_NOTICE.has(license)) {
      continue
    }
    for (const pkg of packages) {
      for (const [index, version] of pkg.versions.entries()) {
        const dir = pkg.paths[index] ?? pkg.paths[0]!
        entries.push({
          name: pkg.name,
          version,
          ecosystem: 'npm',
          license,
          url: pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`,
          text: readNpmLicense(dir),
        })
      }
    }
  }
  return entries
}

/** The package's own LICENSE text, with its NOTICE file appended when it ships one. */
function readNpmLicense(dir: string): string | undefined {
  const files = readdirSync(dir)
  const license = files.find((file) => /^(?:licen[cs]e|copying)(?:\.|-|$)/i.test(file))
  if (!license) {
    return undefined
  }
  const notice = files.find((file) => /^notice(?:\.|$)/i.test(file))
  const parts = [readFileSync(join(dir, license), 'utf8').trim()]
  if (notice) {
    parts.push(readFileSync(join(dir, notice), 'utf8').trim())
  }
  return parts.join('\n\n')
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
  // Reads `about.toml` at the repo root.
  const { stdout } = await exec('cargo', ['about', 'generate', '--format', 'json'], {
    throwOnError: true,
    nodeOptions: { cwd: ROOT_DIR },
  })
  return CargoAboutSchema.parse(JSON.parse(stdout))
    .licenses.filter((license) => !NO_NOTICE.has(license.id))
    .flatMap((license) =>
      license.used_by.map(({ crate }) => ({
        name: crate.name,
        version: crate.version,
        ecosystem: 'cargo' as const,
        license: license.id,
        url: crate.repository ?? `https://crates.io/crates/${crate.name}`,
        text: license.text.trim(),
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
    text: readFileSync(
      join(ROOT_DIR, 'design-system', 'assets', 'fonts', 'LICENSE.txt'),
      'utf8',
    ).trim(),
  }
}

/**
 * One row per package version. cargo-about lists a crate under each license of
 * an `AND` expression, so those rows merge into one with several texts.
 */
function merge(entries: Entry[]): Array<Omit<Entry, 'text'> & { texts: string[] }> {
  const rows = new Map<string, Omit<Entry, 'text'> & { texts: string[] }>()
  for (const { text, ...entry } of entries) {
    const key = `${entry.ecosystem}:${entry.name}@${entry.version}`
    const row = rows.get(key)
    if (row === undefined) {
      rows.set(key, { ...entry, texts: text === undefined ? [] : [text] })
    } else if (text !== undefined && !row.texts.includes(text)) {
      if (!row.license.split(' AND ').includes(entry.license)) {
        row.license = `${row.license} AND ${entry.license}`
      }
      row.texts.push(text)
    }
  }
  return [...rows.values()]
}

/** One copy of each distinct text; rows point at them by index. */
function serialize(entries: Entry[]): { json: string; count: number } {
  const texts: string[] = []
  const textIndex = new Map<string, number>()
  const rows = merge(entries)
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
        a.ecosystem.localeCompare(b.ecosystem) ||
        a.version.localeCompare(b.version, 'en', { numeric: true }),
    )
    .map(({ texts: rowTexts, ...entry }) => ({
      ...entry,
      texts: rowTexts.map((text) => {
        let index = textIndex.get(text)
        if (index === undefined) {
          index = texts.length
          texts.push(text)
          textIndex.set(text, index)
        }
        return index
      }),
    }))
  const json = `${JSON.stringify({ schemaVersion: 1, entries: rows, texts }, null, 2)}\n`
  return { json, count: rows.length }
}

const entries = [...(await collectNpm()), ...(await collectCargo()), collectInter()]
const { json, count } = serialize(entries)
writeFileSync(OUTPUT, json)
console.log(`[licenses] ${count} entries → ${OUTPUT}`)
