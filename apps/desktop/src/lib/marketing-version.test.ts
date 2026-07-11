import { describe, expect, it } from 'vitest'
import { marketingVersion } from './marketing-version'

describe('marketingVersion', () => {
  it('strips the prerelease tag', () => {
    expect(marketingVersion('0.6.0-beta.6')).toBe('0.6.0')
  })

  it('strips build metadata', () => {
    expect(marketingVersion('0.6.0+20260711')).toBe('0.6.0')
  })

  it('keeps a stable version unchanged', () => {
    expect(marketingVersion('0.6.0')).toBe('0.6.0')
  })
})
