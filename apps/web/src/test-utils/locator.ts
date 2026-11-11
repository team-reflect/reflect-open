import type { Locator } from 'vitest/browser'
import { locators } from 'vitest/browser'

declare module 'vitest/browser' {
  interface LocatorSelectors {
    locate(selector: string): Locator
  }
}

locators.extend({
  locate(selector: string): string {
    return selector
  },
})
