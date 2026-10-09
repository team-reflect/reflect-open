// Prints the "Download" section of the release notes as Markdown: one badge
// per installer, each linked to that installer. It reads nothing from the
// network. The asset names of the release are arguments, and an installer
// that is not among them gets no badge.
//
//   node apps/desktop/scripts/release-downloads.ts \
//     --repo=<owner/name> --tag=<tag> --asset=<prefix> <asset-name>...
//
//   --repo   repository that holds the release
//   --tag    release tag, `v` followed by the version
//   --asset  asset name prefix: the product name with spaces as dots
//
// A beta release with macOS and Windows installers:
//
//   node apps/desktop/scripts/release-downloads.ts \
//     --repo=team-reflect/reflect-open \
//     --tag=v0.15.0-beta.5 \
//     --asset=Reflect.Beta \
//     latest.json \
//     Reflect.Beta_0.15.0-beta.5_aarch64.app.tar.gz \
//     Reflect.Beta_0.15.0-beta.5_aarch64.app.tar.gz.sig \
//     Reflect.Beta_0.15.0-beta.5_arm64-setup.exe \
//     Reflect.Beta_0.15.0-beta.5_arm64-setup.exe.sig \
//     Reflect.Beta_0.15.0-beta.5_x64-setup.exe \
//     Reflect.Beta_0.15.0-beta.5_x64-setup.exe.sig \
//     Reflect.Beta_0.15.0-beta.5_x86_64.app.tar.gz \
//     Reflect.Beta_0.15.0-beta.5_x86_64.app.tar.gz.sig \
//     Reflect.Beta_aarch64.dmg \
//     Reflect.Beta_x86_64.dmg
//
// A stable release with macOS installers only. The output has no Windows
// heading:
//
//   node apps/desktop/scripts/release-downloads.ts \
//     --repo=team-reflect/reflect-open \
//     --tag=v0.14.0 \
//     --asset=Reflect \
//     latest.json \
//     Reflect_0.14.0_aarch64.app.tar.gz \
//     Reflect_0.14.0_aarch64.app.tar.gz.sig \
//     Reflect_0.14.0_x86_64.app.tar.gz \
//     Reflect_0.14.0_x86_64.app.tar.gz.sig \
//     Reflect_aarch64.dmg \
//     Reflect_x86_64.dmg
//
// The asset names of a published release, read with the GitHub CLI:
//
//   node apps/desktop/scripts/release-downloads.ts \
//     --repo=team-reflect/reflect-open --tag=v0.14.0 --asset=Reflect \
//     $(gh release view v0.14.0 --repo team-reflect/reflect-open --json assets --jq '.assets[].name')

import { parseArgs } from 'node:util'

function fail(message: string): never {
  console.error(`[release-downloads] ${message}`)
  process.exit(1)
}

const { values, positionals: assetNames } = parseArgs({
  options: { repo: { type: 'string' }, tag: { type: 'string' }, asset: { type: 'string' } },
  allowPositionals: true,
})
const { repo, tag, asset } = values
if (!repo || !tag || !asset) {
  fail('--repo, --tag, and --asset are required')
}
if (!/^v\d/.test(tag)) {
  fail(`invalid --tag "${tag}": expected "v" and a version, such as v0.15.0-beta.5`)
}
const version = tag.slice(1)

const INSTALLERS = [
  { os: 'macOS', chip: 'Apple Silicon', color: '16A34A', file: `${asset}_aarch64.dmg` },
  { os: 'macOS', chip: 'Intel', color: 'D97706', file: `${asset}_x86_64.dmg` },
  { os: 'Windows', chip: 'x64', color: '2563EB', file: `${asset}_${version}_x64-setup.exe` },
  { os: 'Windows', chip: 'ARM64', color: '7C3AED', file: `${asset}_${version}_arm64-setup.exe` },
]

let markdown = '## Download\n'
for (const os of ['macOS', 'Windows']) {
  const badges = INSTALLERS.filter((item) => item.os === os && assetNames.includes(item.file)).map(
    ({ chip, color, file }) => {
      const icon = os === 'macOS' ? 'apple' : 'windows'
      const image = `https://badgen.net/badge/${os}/${encodeURIComponent(chip)}/${color}?icon=${icon}&style=flat`
      return `[![${os} ${chip}](${image})](https://github.com/${repo}/releases/download/${tag}/${file})`
    },
  )
  if (badges.length > 0) {
    markdown += `\n### ${os}\n\n${badges.join(' ')}\n`
  }
}
if (!markdown.includes('###')) {
  fail(
    `no installer among the asset names. Expected: ${INSTALLERS.map((item) => item.file).join(', ')}`,
  )
}
process.stdout.write(markdown)
