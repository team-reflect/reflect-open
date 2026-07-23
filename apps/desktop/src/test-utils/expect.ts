import { expect, type ExpectPollOptions } from 'vitest'
import type { Locator } from 'vitest/browser'

export async function expectLocatorToHaveCount(
  locator: Locator,
  count: number,
  options?: ExpectPollOptions,
): Promise<void> {
  await expect.poll(() => locator.elements(), options).toHaveLength(count)
}
