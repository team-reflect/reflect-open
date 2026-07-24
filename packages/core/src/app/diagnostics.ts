import { z } from 'zod'
import { call } from '../ipc/invoke'

const timestampSchema = z.number().int().nonnegative()
const buildSchema = z.string().regex(/^[0-9]{1,32}$/).nullable()
const appVersionSchema = z
  .string()
  .max(64)
  .regex(/^(?:unknown|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)

export const diagnosticCheckpointSchema = z.enum([
  'platformResolved',
  'mobileRootMounted',
  'graphLoading',
  'graphOpening',
  'graphReady',
  'graphUnavailable',
  'indexReconcileStarted',
  'indexLive',
  'backgrounded',
  'foregrounded',
])

export type DiagnosticCheckpoint = z.infer<typeof diagnosticCheckpointSchema>

const safeModeReasonSchema = z.literal('repeatedWebContentTerminations')

const diagnosticsStatusSchema = z
  .object({
    safeMode: z.boolean(),
    reason: safeModeReasonSchema.nullable(),
    recentWebContentTerminations: z.number().int().nonnegative(),
  })
  .strict()

export type DiagnosticsStatus = z.infer<typeof diagnosticsStatusSchema>

const diagnosticEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('appStarted'),
      atMs: timestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('checkpoint'),
      atMs: timestampSchema,
      checkpoint: diagnosticCheckpointSchema,
    })
    .strict(),
  z.object({ kind: z.literal('frontendReady'), atMs: timestampSchema }).strict(),
  z
    .object({
      kind: z.literal('webContentTerminated'),
      atMs: timestampSchema,
      uptimeMs: timestampSchema,
      window: z.enum(['main', 'note', 'other']),
      recentCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('webContentReloaded'),
      atMs: timestampSchema,
      success: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('safeModeEntered'),
      atMs: timestampSchema,
      reason: safeModeReasonSchema,
    })
    .strict(),
  z.object({ kind: z.literal('safeModeCleared'), atMs: timestampSchema }).strict(),
])

export const diagnosticsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAtMs: timestampSchema,
    appVersion: appVersionSchema,
    build: buildSchema,
    safeMode: z.boolean(),
    reason: safeModeReasonSchema.nullable(),
    recentWebContentTerminations: z.number().int().nonnegative(),
    events: z.array(diagnosticEventSchema).max(128),
  })
  .strict()

export type DiagnosticsSnapshot = z.infer<typeof diagnosticsSnapshotSchema>

/**
 * Records the native/WebView session boundary and returns the persisted iOS
 * recovery state. Call before mounting providers that can open note storage.
 */
export async function bootstrapDiagnostics(): Promise<DiagnosticsStatus> {
  return call('diagnostics_bootstrap', {}, diagnosticsStatusSchema)
}

/** Records one closed lifecycle checkpoint without accepting arbitrary text. */
export async function recordDiagnosticCheckpoint(
  checkpoint: DiagnosticCheckpoint,
): Promise<void> {
  await call('diagnostics_checkpoint', { checkpoint }, z.null())
}

/** Marks the graph-backed workspace as usable after startup or a WebView reload. */
export async function markDiagnosticsFrontendReady(): Promise<void> {
  await call('diagnostics_frontend_ready', {}, z.null())
}

/** Clears sticky recovery mode so the next reload can attempt normal startup. */
export async function retryNormalDiagnosticsStartup(): Promise<void> {
  await call('diagnostics_retry_normal', {}, z.null())
}

/** Returns the already-scrubbed, bounded journal for explicit user sharing. */
export async function getDiagnosticsSnapshot(): Promise<DiagnosticsSnapshot> {
  return call('diagnostics_snapshot', {}, diagnosticsSnapshotSchema)
}
