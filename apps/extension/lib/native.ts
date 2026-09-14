import { browser } from 'wxt/browser'
import { captureAckSchema, captureCapabilitiesSchema, type ExtensionCaptureWire } from '@reflect/core/capture-envelope'
import type { HoldReason } from './messages'

/**
 * The native-messaging hop: one `sendNativeMessage` per capture to the
 * `reflect-capture-host` sidecar the desktop app registered. Chrome spawns
 * the host per message — no port, no daemon — and the host's only honest
 * success is `queued` (it spools into the capture inbox and exits; it never
 * observes the desktop app draining).
 */

/** Must match the host manifest name written by `src-tauri/src/capture.rs`. */
export const HOST_NAME = 'app.reflect.capture'

export type SendOutcome =
  /** The host spooled the capture — remove it from the queue. */
  | { kind: 'queued' }
  /** The host says this payload can never spool — drop it, loudly. */
  | { kind: 'rejected'; message: string }
  /** Transient — keep the capture queued and retry later. */
  | { kind: 'held'; reason: HoldReason; message: string }

/**
 * Chrome rejects with these strings when the host manifest is missing or
 * doesn't allowlist this extension — the "install / launch Reflect" state.
 */
const NO_HOST_PATTERN = /not found|forbidden|not installed/i

export async function sendToHost(wire: ExtensionCaptureWire): Promise<SendOutcome> {
  if (wire.envelope.kind === 'x-like') {
    const unsupported = await checkLikeCapability()
    if (unsupported !== null) return unsupported
  }
  let raw: unknown
  try {
    raw = await browser.runtime.sendNativeMessage(HOST_NAME, wire)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return {
      kind: 'held',
      reason: NO_HOST_PATTERN.test(message) ? 'no-host' : 'io',
      message,
    }
  }
  const ack = captureAckSchema.safeParse(raw)
  if (!ack.success) {
    return { kind: 'held', reason: 'io', message: 'unrecognized ack from the capture host' }
  }
  if (ack.data.ok) {
    return { kind: 'queued' }
  }
  switch (ack.data.code) {
    case 'invalid-payload':
      if (wire.envelope.kind === 'x-like') {
        return { kind: 'held', reason: 'io', message: ack.data.message }
      }
      return { kind: 'rejected', message: ack.data.message }
    case 'no-graph':
      return { kind: 'held', reason: 'no-graph', message: ack.data.message }
    case 'unsupported-version':
      return { kind: 'held', reason: 'unsupported-version', message: ack.data.message }
    case 'io':
      return { kind: 'held', reason: 'io', message: ack.data.message }
  }
}

/** Check the current host and graph reader before sending a like. */
async function checkLikeCapability(): Promise<SendOutcome | null> {
  let raw: unknown
  try {
    raw = await browser.runtime.sendNativeMessage(HOST_NAME, { type: 'capture-capabilities' })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { kind: 'held', reason: NO_HOST_PATTERN.test(message) ? 'no-host' : 'io', message }
  }
  const capabilities = captureCapabilitiesSchema.safeParse(raw)
  if (capabilities.success && capabilities.data.xLikeVersion === 2) return null
  const ack = captureAckSchema.safeParse(raw)
  if (capabilities.success || (ack.success && !ack.data.ok &&
      (ack.data.code === 'invalid-payload' || ack.data.code === 'unsupported-version'))) {
    return {
      kind: 'held', reason: 'unsupported-version',
      message: 'Update Reflect to save liked posts. Your captures are still queued.',
    }
  }
  if (ack.success && !ack.data.ok) {
    return { kind: 'held', reason: ack.data.code === 'no-graph' ? 'no-graph' : 'io', message: ack.data.message }
  }
  return { kind: 'held', reason: 'io', message: 'Unrecognized capture capability response.' }
}
