// Prints the release notes of a release with a fresh "Download" section: one
// badge per installer, each linked to that installer, and one badge for iPhone
// and iPad, linked to TestFlight for a beta version or to the App Store for a
// stable one. It reads the release as JSON from stdin, keeps the body, and
// replaces the section between the RELEASE_NOTES_DOWNLOAD_LINKS_START and _END
// markers, so a rerun gives the same result. An installer that is not among
// the assets gets no badge.
//
//   gh release view <tag> --json body,assets |
//     node apps/desktop/scripts/write-release-notes.ts --tag=<tag> --asset=<prefix>
//
//   --tag    release tag, `v` followed by the version
//   --asset  asset name prefix: the product name with spaces as dots
//
// The repository comes from GITHUB_REPOSITORY. To preview a published release:
//
//   gh release view v0.16.0 --repo team-reflect/reflect-open --json body,assets |
//     GITHUB_REPOSITORY=team-reflect/reflect-open \
//     node apps/desktop/scripts/write-release-notes.ts --tag=v0.16.0 --asset=Reflect

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

function fail(message: string): never {
  console.error(`[write-release-notes] ${message}`)
  process.exit(1)
}

const { values } = parseArgs({
  options: { tag: { type: 'string' }, asset: { type: 'string' } },
})
const { tag, asset } = values
const repo = process.env.GITHUB_REPOSITORY
if (!tag || !asset || !repo) {
  fail('--tag, --asset, and GITHUB_REPOSITORY are required')
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

const INSTALLERS = [
  { os: 'macOS', chip: 'Apple Silicon', color: '0969DA', file: `${asset}_aarch64.dmg` },
  { os: 'macOS', chip: 'Universal', color: '8250DF', file: `${asset}_universal.dmg` },
  { os: 'Windows', chip: 'x64', color: '1A7F37', file: `${asset}_${version}_x64-setup.exe` },
  { os: 'Windows', chip: 'ARM64', color: '1B7C83', file: `${asset}_${version}_arm64-setup.exe` },
  {
    os: 'Linux',
    chip: 'x64 AppImage',
    color: '9A6700',
    file: `${asset}_${version}_amd64.AppImage`,
  },
  { os: 'Linux', chip: 'x64 .deb', color: 'BC4C00', file: `${asset}_${version}_amd64.deb` },
  {
    os: 'Linux',
    chip: 'ARM64 AppImage',
    color: 'CF222E',
    file: `${asset}_${version}_aarch64.AppImage`,
  },
  { os: 'Linux', chip: 'ARM64 .deb', color: 'BF3989', file: `${asset}_${version}_arm64.deb` },
]

const PLATFORMS = [
  { os: 'macOS', heading: 'macOS', icon: 'apple' },
  { os: 'Windows', heading: 'Windows', icon: 'windows' },
  { os: 'Linux', heading: 'Linux', icon: 'linux' },
  { os: 'iOS', heading: 'iPhone & iPad', icon: 'apple' },
]

const links = INSTALLERS.filter((item) => assetNames.includes(item.file)).map(
  ({ file, ...item }) => ({
    ...item,
    url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
  }),
)
if (links.length === 0) {
  fail(
    `no installer among the asset names. Expected: ${INSTALLERS.map((item) => item.file).join(', ')}`,
  )
}
const ios = version.includes('-')
  ? { chip: 'TestFlight', url: 'https://testflight.apple.com/join/j2eEz43d' }
  : { chip: 'App Store', url: 'https://apps.apple.com/us/app/reflect-open/id6787385615' }
links.push({ os: 'iOS', color: '57606A', ...ios })

let section = '<!-- RELEASE_NOTES_DOWNLOAD_LINKS_START -->\n\n## Download\n'
for (const { os, heading, icon } of PLATFORMS) {
  const badges = links
    .filter((item) => item.os === os)
    .map(({ chip, color, url }) => {
      const label = `${heading} ${chip}`
      const image = `https://badgen.net/badge/${encodeURIComponent(label)}/${encodeURIComponent(tag)}/${color}?icon=${icon}`
      return `[![${label}](${image})](${url})`
    })
  if (badges.length > 0) {
    section += `\n### ${heading}\n\n${badges.join(' ')}\n`
  }
}
section += '\n<!-- RELEASE_NOTES_DOWNLOAD_LINKS_END -->\n'

const body = release.body
  .replace(/^.*RELEASE_NOTES_DOWNLOAD_LINKS_START[^]*?RELEASE_NOTES_DOWNLOAD_LINKS_END.*$/m, '')
  .trimEnd()
process.stdout.write(body ? `${body}\n\n${section}` : section)
