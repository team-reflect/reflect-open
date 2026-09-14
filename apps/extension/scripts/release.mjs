import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ChromeWebStoreV2 } from 'publish-browser-extension'
import { z } from 'zod'

const command = z.enum(['verify', 'submit', 'dry-run']).parse(process.argv[2])
const root = resolve(import.meta.dirname, '..')
const versionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine((value) => value !== '0.0.0' && value.split('.').every((part) => Number(part) <= 65535))
const { version } = z
  .object({ version: versionSchema })
  .parse(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')))
const zip = resolve(root, '.output', `reflect-capture-${version}-chrome.zip`)
const manifest = JSON.parse(execFileSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8' }))
z.object({
  manifest_version: z.literal(3),
  name: z.literal('Reflect Capture'),
  version: z.literal(version),
  key: z.never().optional(),
}).parse(manifest)

if (command !== 'verify') {
  await submit()
}

async function submit() {
  const credentials = z
    .object({
      CHROME_PUBLISHER_ID: z.string().min(1),
      CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: z.email(),
      CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().min(1),
    })
    .parse(process.env)
  const store = new ChromeWebStoreV2(
    {
      apiVersion: 'v2',
      extensionId: 'ccabifmooehighoonjeiololjfofkhkd',
      publisherId: credentials.CHROME_PUBLISHER_ID,
      serviceAccountClientEmail: credentials.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL,
      serviceAccountPrivateKey: credentials.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY,
      zip,
      cancelPending: false,
      skipSubmitReview: false,
      publishType: 'DEFAULT_PUBLISH',
    },
    console.log,
  )
  const revisionSchema = z.object({
    state: z.string(),
    distributionChannels: z.array(z.object({ crxVersion: z.string() })).default([]),
  })
  const status = z
    .object({
      takenDown: z.boolean().optional(),
      warned: z.boolean().optional(),
      publishedItemRevisionStatus: revisionSchema.optional(),
      submittedItemRevisionStatus: revisionSchema.optional(),
      lastAsyncUploadState: z.string().optional(),
    })
    .parse(await store.getStatus())
  if (command === 'dry-run') {
    report(`Chrome credentials verified. No upload or submission.\n\n${JSON.stringify(status, null, 2)}`)
    return
  }
  if (status.takenDown || status.warned) {
    throw new Error('Resolve the Chrome Web Store warning or takedown in the dashboard first.')
  }
  const published = status.publishedItemRevisionStatus
  if (published?.distributionChannels.some((channel) => channel.crxVersion === version)) {
    report(`Reflect Capture ${version} is already published.`)
    return
  }
  const submitted = status.submittedItemRevisionStatus
  if (submitted && !['CANCELLED', 'REJECTED', 'PUBLISHED'].includes(submitted.state)) {
    if (
      ['PENDING_REVIEW', 'STAGED'].includes(submitted.state) &&
      submitted.distributionChannels.some((channel) => channel.crxVersion === version)
    ) {
      report(`Reflect Capture ${version}: ${submitted.state}. No new upload or submission.`)
      return
    }
    throw new Error(`Another submission exists (${submitted.state}). Resolve it in the dashboard.`)
  }
  if (['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(status.lastAsyncUploadState)) {
    throw new Error('Chrome is still processing an upload. Inspect the dashboard before retrying.')
  }
  await store.submit()
  report(`Reflect Capture ${version} submitted. Chrome will publish it after review approval.`)
}

function report(message) {
  console.log(message)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
  }
}
