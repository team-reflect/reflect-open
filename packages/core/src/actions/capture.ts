/**
 * Link capture (Plan 11), the second of the `actions/` capture family — the
 * same raw-first shape as audio memos. Spooled envelopes are drained into
 * durable raw capture notes, then enrichment patches those notes later and
 * retries freely.
 */
export {
  captureFromPath,
  captureIdentity,
  isCaptureSpoolPath,
  type CaptureIdentity,
} from './capture-identity'
export { captureNoteMeta, type CaptureNoteMeta, type CaptureStatus } from './capture-note'
export {
  drainCaptureInbox,
  type DrainCaptureInboxInput,
  type DrainCaptureInboxOutcome,
} from './capture-drain'
export {
  listPendingCaptures,
  reconcileCaptureEnrichment,
  type ReconcileCaptureEnrichmentInput,
  type ReconcileCaptureEnrichmentOutcome,
} from './capture-enrichment'
