import type { Locator } from 'vitest/browser'
import { locators } from 'vitest/browser'

declare module 'vitest/browser' {
  interface LocatorSelectors {
    /** Locate elements by a raw CSS selector. */
    locate(selector: string): Locator
  }
}

locators.extend({
  locate(selector: string): string {
    return selector
  },
})
