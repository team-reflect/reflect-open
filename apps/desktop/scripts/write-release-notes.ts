// Prints the release notes of a release with a fresh "Download" section: one
// badge per installer, each linked to that installer, and one badge for iPhone
// and iPad, linked to TestFlight for a beta version or to the App Store for a
// stable one. It reads the release as JSON from stdin, keeps the body, and
// replaces the section between the RELEASE_NOTES_DOWNLOAD_LINKS_START and _END
// markers, so a rerun gives the same result. An installer that is not among
// the assets gets no badge.
//
//   gh release view <tag> --json body,assets |
//     node apps/desktop/scripts/write-release-notes.ts --tag=<tag> --asset-prefix=<prefix>
//
//   --tag           release tag, `v` followed by the version
//   --asset-prefix  asset name prefix: the product name with spaces as dots
//
// The repository comes from GITHUB_REPOSITORY. To preview a published release:
//
//   gh release view v0.16.0 --repo team-reflect/reflect-open --json body,assets |
//     GITHUB_REPOSITORY=team-reflect/reflect-open \
//     node apps/desktop/scripts/write-release-notes.ts --tag=v0.16.0 --asset-prefix=Reflect

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

function fail(message: string): never {
  console.error(`[write-release-notes] ${message}`)
  process.exit(1)
}

const { values } = parseArgs({
  options: { tag: { type: 'string' }, 'asset-prefix': { type: 'string' } },
})
const { tag, 'asset-prefix': prefix } = values
const repo = process.env.GITHUB_REPOSITORY
if (!tag || !prefix || !repo) {
  fail('--tag, --asset-prefix, and GITHUB_REPOSITORY are required')
}
if (!/^v\d/.test(tag)) {
  fail(`invalid --tag "${tag}": expected "v" and a version, such as v0.15.0-beta.5`)
}
const version = tag.slice(1)

const release = JSON.parse(readFileSync(0, 'utf8')) as {
  body: string
  assets: { name: string }[]
}
const assetNames = release.assets.map((item) => item.name)

/**
 * A badge links either to an installer `file` on the release, shown only when
 * the release has it, or to an outside `url`.
 */
type Badge = { variant: string; color: string } & (
  | { file: string; url?: undefined }
  | { url: string; file?: undefined }
)

const PLATFORMS: { heading: string; icon: string; badges: Badge[] }[] = [
  {
    heading: 'Mac',
    icon: 'apple',
    badges: [
      { variant: 'Apple Silicon', color: '0969DA', file: `${prefix}_aarch64.dmg` },
      { variant: 'Universal', color: '8250DF', file: `${prefix}_universal.dmg` },
    ],
  },
  {
    heading: 'Windows',
    icon: 'windows',
    badges: [
      { variant: 'x64', color: '1A7F37', file: `${prefix}_${version}_x64-setup.exe` },
      { variant: 'ARM64', color: '1B7C83', file: `${prefix}_${version}_arm64-setup.exe` },
    ],
  },
  {
    heading: 'Linux',
    icon: 'linux',
    badges: [
      { variant: 'x64 AppImage', color: '9A6700', file: `${prefix}_${version}_amd64.AppImage` },
      { variant: 'x64 .deb', color: 'BC4C00', file: `${prefix}_${version}_amd64.deb` },
      { variant: 'ARM64 AppImage', color: '9E1F63', file: `${prefix}_${version}_aarch64.AppImage` },
      { variant: 'ARM64 .deb', color: 'BF3989', file: `${prefix}_${version}_arm64.deb` },
    ],
  },
  {
    heading: 'iPhone & iPad',
    icon: 'apple',
    badges: [
      version.includes('-')
        ? {
            variant: 'TestFlight',
            color: '0369A1',
            url: 'https://testflight.apple.com/join/j2eEz43d',
          }
        : {
            variant: 'App Store',
            color: '0369A1',
            url: 'https://apps.apple.com/us/app/reflect-open/id6787385615',
          },
    ],
  },
]

const files = PLATFORMS.flatMap((platform) => {
  return platform.badges.flatMap((badge) => badge.file ?? [])
})
if (!files.some((file) => assetNames.includes(file))) {
  fail(`no installer among the asset names. Expected: ${files.join(', ')}`)
}

let section = `<!-- RELEASE_NOTES_DOWNLOAD_LINKS_START -->\n\n## Download\n\n| Platform | Download (${tag}) |\n| --- | --- |\n`
for (const { heading, icon, badges } of PLATFORMS) {
  const markdown = badges
    .filter((badge) => badge.file === undefined || assetNames.includes(badge.file))
    .map((badge) => {
      const image = `https://badgen.net/badge/icon/${encodeURIComponent(badge.variant)}/${badge.color}?icon=${icon}&label=&style=flat`
      const url = badge.url ?? `https://github.com/${repo}/releases/download/${tag}/${badge.file}`
      return `[![${heading} ${badge.variant}](${image})](${url})`
    })
  if (markdown.length > 0) {
    section += `| **${heading}** | ${markdown.join('<br>')} |\n`
  }
}
section += '\n<!-- RELEASE_NOTES_DOWNLOAD_LINKS_END -->\n'

const body = release.body
  .replace(/^.*RELEASE_NOTES_DOWNLOAD_LINKS_START[\s\S]*?RELEASE_NOTES_DOWNLOAD_LINKS_END.*$/m, '')
  .trimEnd()
process.stdout.write(body ? `${body}\n\n${section}` : section)
