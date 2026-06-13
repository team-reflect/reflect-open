import { describe, expect, it } from 'vitest'
import fixtures from './capture-envelope.fixtures.json'
import { captureWireMessageSchema } from './capture-envelope'

/**
 * One half of the shared contract pin — the other half is the parity test in
 * `apps/native-host/src/envelope.rs`, which runs the SAME fixtures through
 * the host's serde mirror. Together they enforce: the host never spools an
 * envelope this schema would quarantine at drain, and the two validators
 * cannot drift apart silently. Add new cases to the fixtures file, never to
 * one side only.
 */

describe('capture wire-message contract fixtures', () => {
  it.each(fixtures.accepted.map((fixture) => [fixture.name, fixture.message] as const))(
    'accepts: %s',
    (_name, message) => {
      const parsed = captureWireMessageSchema.safeParse(message)
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
        true,
      )
    },
  )

  it.each(fixtures.rejected.map((fixture) => [fixture.name, fixture.message] as const))(
    'rejects: %s',
    (_name, message) => {
      expect(captureWireMessageSchema.safeParse(message).success).toBe(false)
    },
  )
})
