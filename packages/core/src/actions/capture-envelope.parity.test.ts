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
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true)
      if ('x' in message.envelope && parsed.success) {
        expect(parsed.data.envelope).toHaveProperty('x', message.envelope.x)
      }
    },
  )

  it.each(fixtures.rejected.map((fixture) => [fixture.name, fixture.message] as const))(
    'rejects: %s',
    (_name, message) => {
      expect(captureWireMessageSchema.safeParse(message).success).toBe(false)
    },
  )
})

describe('X spool byte boundary', () => {
  it('measures UTF-8 and includes the host-stamped screenshot reference', () => {
    const fixture = fixtures.accepted.find((candidate) => candidate.name === 'X manual snapshot')
    if (!fixture) throw new Error('Missing X fixture')
    const envelope = { ...fixture.message.envelope, note: '界'.repeat(22_000) }
    expect(captureWireMessageSchema.safeParse({ envelope }).success).toBe(false)

    const small = { ...fixture.message.envelope, note: '' }
    const size = new TextEncoder().encode(JSON.stringify(small)).length
    const atCap = { ...small, note: 'a'.repeat(65_536 - size) }
    expect(captureWireMessageSchema.safeParse({ envelope: atCap }).success).toBe(true)
    expect(
      captureWireMessageSchema.safeParse({ envelope: atCap, screenshotBase64: 'aGVsbG8=' }).success,
    ).toBe(false)
  })
})
