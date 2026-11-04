// Uploads what `pnpm build:ios` made: the dSYMs to Sentry, then the IPA to
// TestFlight. See docs/distribution.md.
//
//   pnpm upload:testflight

import { join } from 'node:path'
import { exec } from 'tinyexec'
import {
  APP_DIR,
  INHERIT,
  IOS_ARCHIVE_PATH,
  IOS_IPA_PATH,
  resolveApiKey,
  runWithTempDir,
} from './helpers.ts'

async function main(): Promise<void> {
  await runWithTempDir(async (tempDir) => {
    const apiKey = resolveApiKey(tempDir)
    if (!apiKey) {
      throw new Error('the App Store Connect API key is not set')
    }

    const sentryCli = join(APP_DIR, 'node_modules', '.bin', 'sentry-cli')
    const project = ['--org', 'reflect-64', '--project', 'reflect-open']
    const dsyms = ['--type', 'dsym', '--no-sources', '--wait-for', '60', IOS_ARCHIVE_PATH]
    await exec(sentryCli, ['debug-files', 'upload', ...project, ...dsyms], INHERIT)

    const { keyId, issuer, keyPath } = apiKey
    const credentials = ['--api-key', keyId, '--api-issuer', issuer, '--p8-file-path', keyPath]
    // --wait blocks until App Store Connect has processed the build.
    const upload = ['--upload-package', IOS_IPA_PATH, '--show-progress', '--wait']
    await exec('xcrun', ['altool', ...upload, ...credentials, '--output-format', 'json'], {
      throwOnError: true,
      nodeOptions: { env: { APPLE_API_KEY_PATH: keyPath }, stdio: 'inherit' },
    })
  })
}

await main()
