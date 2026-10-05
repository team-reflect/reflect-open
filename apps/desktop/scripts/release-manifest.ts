// Writes the updater manifest (latest.json) of a release and uploads it.
// The manifest is rebuilt from the signature files on the release, so a rerun
// gives the same result.
//
//   pnpm release:manifest --tag=<tag>

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'
import { INHERIT, log, runWithTempDir } from './helpers.ts'

/** The updater looks up `<os>-<arch>` in the manifest. An optional platform without a signature is left out. */
const PLATFORMS = [
  { platform: 'darwin-aarch64', suffix: '_aarch64.app.tar.gz.sig', required: true },
  { platform: 'darwin-x86_64', suffix: '_x86_64.app.tar.gz.sig', required: true },
  { platform: 'windows-x86_64', suffix: '_x64-setup.exe.sig', required: false },
  { platform: 'windows-aarch64', suffix: '_arm64-setup.exe.sig', required: false },
]

interface PlatformEntry {
  readonly signature: string
  readonly url: string
}

/**
 * Builds the `platforms` object from the signature files in `dir`. The URL
 * uses the tag, because a draft release serves its assets from a temporary
 * `untagged-...` path.
 */
function buildPlatforms(dir: string, baseUrl: string): Record<string, PlatformEntry> {
  const signatures = readdirSync(dir)
  const platforms: Record<string, PlatformEntry> = {}
  for (const { platform, suffix, required } of PLATFORMS) {
    const signature = signatures.find((name) => name.endsWith(suffix))
    if (signature) {
      platforms[platform] = {
        signature: readFileSync(join(dir, signature), 'utf8').trim(),
        url: `${baseUrl}/${signature.slice(0, -'.sig'.length)}`,
      }
    } else if (required) {
      throw new Error(`the release has no *${suffix} asset`)
    }
  }
  return platforms
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { tag: { type: 'string', default: '' } } })
  const { tag } = values
  if (!tag.startsWith('v')) {
    throw new Error(`invalid tag "${tag}"`)
  }
  const repoArgs = ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']
  const repo = await exec('gh', repoArgs, { throwOnError: true })
  const baseUrl = `https://github.com/${repo.stdout.trim()}/releases/download/${tag}`

  await runWithTempDir(async (tempDir) => {
    await exec('gh', ['release', 'download', tag, '--pattern', '*.sig', '--dir', tempDir], INHERIT)
    const manifest = {
      version: tag.slice(1),
      pub_date: new Date().toISOString(),
      platforms: buildPlatforms(tempDir, baseUrl),
    }
    const manifestPath = join(tempDir, 'latest.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await exec('gh', ['release', 'upload', tag, manifestPath, '--clobber'], INHERIT)
    log(`uploaded latest.json for ${Object.keys(manifest.platforms).join(', ')}`)
  })
}

await main()
