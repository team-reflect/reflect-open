// Prints the "Download" section of the release notes as Markdown: one badge
// per installer, each linked to that installer. It reads nothing from the
// network. The asset names of the release are arguments, and an installer
// that is not among them gets no badge.
//
//   node apps/desktop/scripts/release-downloads.ts \
//     --repo=<owner/name> --tag=<tag> --version=<version> --asset=<prefix> <asset-name>...
//
//   --repo     repository that holds the release
//   --tag      release tag, `v` followed by the version
//   --version  app version, shown on each badge
//   --asset    asset name prefix: the product name with spaces as dots
//
// A beta release with macOS and Windows installers:
//
//   node apps/desktop/scripts/release-downloads.ts \
//     --repo=team-reflect/reflect-open \
//     --tag=v0.15.0-beta.5 \
//     --version=0.15.0-beta.5 \
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
//     --version=0.14.0 \
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
//     --repo=team-reflect/reflect-open --tag=v0.14.0 --version=0.14.0 --asset=Reflect \
//     $(gh release view v0.14.0 --repo team-reflect/reflect-open --json assets --jq '.assets[].name')

import { parseArgs } from 'node:util'

interface Release {
  readonly repo: string
  readonly tag: string
  readonly version: string
  readonly asset: string
}

interface Installer {
  readonly label: string
  readonly color: string
  readonly icon: string
  readonly getFileName: (release: Release) => string
}

interface Platform {
  readonly title: string
  readonly installers: readonly Installer[]
}

const PLATFORMS: readonly Platform[] = [
  {
    title: 'macOS',
    installers: [
      {
        label: 'macOS Apple Silicon',
        color: '7C3AED',
        icon: 'apple',
        getFileName: ({ asset }) => `${asset}_aarch64.dmg`,
      },
      {
        label: 'macOS Intel',
        color: 'D97706',
        icon: 'apple',
        getFileName: ({ asset }) => `${asset}_x86_64.dmg`,
      },
    ],
  },
  {
    title: 'Windows',
    installers: [
      {
        label: 'Windows x64',
        color: '2563EB',
        icon: 'windows',
        getFileName: ({ asset, version }) => `${asset}_${version}_x64-setup.exe`,
      },
      {
        label: 'Windows ARM64',
        color: '0D9488',
        icon: 'windows',
        getFileName: ({ asset, version }) => `${asset}_${version}_arm64-setup.exe`,
      },
    ],
  },
]

function renderBadge(installer: Installer, release: Release): string {
  const { label, color, icon } = installer
  const image = `https://badgen.net/badge/${encodeURIComponent(label)}/v${release.version}/${color}?icon=${icon}&style=flat`
  const link = `https://github.com/${release.repo}/releases/download/${release.tag}/${installer.getFileName(release)}`
  return `[![${label}](${image})](${link})`
}

/** Renders the section. A platform with no published installer is left out. */
function renderDownloads(release: Release, assetNames: readonly string[]): string {
  const sections: string[] = []
  for (const { title, installers } of PLATFORMS) {
    const badges = installers
      .filter((installer) => assetNames.includes(installer.getFileName(release)))
      .map((installer) => renderBadge(installer, release))
    if (badges.length > 0) {
      sections.push(`### ${title}\n\n${badges.join(' ')}\n`)
    }
  }
  if (sections.length === 0) {
    const expected = PLATFORMS.flatMap(({ installers }) =>
      installers.map((installer) => installer.getFileName(release)),
    )
    throw new Error(
      `none of the ${assetNames.length} asset names is an installer of this release. Expected at least one of: ${expected.join(', ')}`,
    )
  }
  return `## Download\n\n${sections.join('\n')}`
}

function parseRelease(values: Record<string, string>): Release {
  const { repo = '', tag = '', version = '', asset = '' } = values
  const missing = Object.entries({ repo, tag, version, asset })
    .filter(([, value]) => !value)
    .map(([name]) => `--${name}`)
  if (missing.length > 0) {
    throw new Error(`missing required option: ${missing.join(', ')}`)
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(
      `invalid --repo "${repo}": expected <owner>/<name>, such as team-reflect/reflect-open`,
    )
  }
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    throw new Error(
      `invalid --version "${version}": expected a version without "v", such as 0.15.0-beta.5`,
    )
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `--tag "${tag}" does not match --version "${version}": expected --tag=v${version}`,
    )
  }
  if (!/^[\w.-]+$/.test(asset)) {
    throw new Error(
      `invalid --asset "${asset}": expected the product name with spaces as dots, such as Reflect.Beta`,
    )
  }
  return { repo, tag, version, asset }
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      repo: { type: 'string' },
      tag: { type: 'string' },
      version: { type: 'string' },
      asset: { type: 'string' },
    },
    allowPositionals: true,
  })
  const release = parseRelease(values)
  if (positionals.length === 0) {
    throw new Error('no asset names: pass the name of every asset of the release after the options')
  }
  process.stdout.write(renderDownloads(release, positionals))
}

try {
  main()
} catch (error) {
  console.error(`[release-downloads] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
