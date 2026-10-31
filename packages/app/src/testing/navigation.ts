import type { Unlisten } from '@reflect/core'
import {
  createNavigationService,
  type NavigateOptions,
  type NavigationPosition,
  type NavigationService,
  type NavigationState,
} from '../navigation/navigation-service.ts'
import type { Route } from '../navigation/route.ts'

export interface TestNavigationServiceOptions {
  /**
   * The route the history starts on; defaults to today.
   */
  initialRoute?: Route
}

/**

 * One `navigate` call as the caller made it (before route normalization).

 */
export interface TestNavigateCall {
  route: Route
  options: NavigateOptions | undefined
}

export interface TestNavigationService extends NavigationService {
  /**
   * Every `navigate` call, in order.
   */
  navigations(): readonly TestNavigateCall[]
}

class TestNavigationServiceImpl implements TestNavigationService {
  readonly #inner: NavigationService
  readonly #calls: TestNavigateCall[] = []

  constructor(inner: NavigationService) {
    this.#inner = inner
  }

  getState(): NavigationState {
    return this.#inner.getState()
  }

  subscribe(listener: () => void): Unlisten {
    return this.#inner.subscribe(listener)
  }

  navigate(route: Route, navigateOptions?: NavigateOptions): void {
    this.#calls.push({ route, options: navigateOptions })
    this.#inner.navigate(route, navigateOptions)
  }

  back(): void {
    this.#inner.back()
  }

  forward(): void {
    this.#inner.forward()
  }

  navigationRevision(): number {
    return this.#inner.navigationRevision()
  }

  saveScrollState(offset: number, at?: NavigationPosition): void {
    this.#inner.saveScrollState(offset, at)
  }

  clearScrollState(at?: NavigationPosition): void {
    this.#inner.clearScrollState(at)
  }

  savedScroll(at?: NavigationPosition): number | null {
    return this.#inner.savedScroll(at)
  }

  noteMoved(from: string, to: string): void {
    this.#inner.noteMoved(from, to)
  }

  reset(initialRoute?: Route): void {
    this.#inner.reset(initialRoute)
  }

  navigations(): readonly TestNavigateCall[] {
    return [...this.#calls]
  }
}

/**

 * The real {@link NavigationService}, recording each `navigate` call.

 */
export function createTestNavigationService(
  options?: TestNavigationServiceOptions,
): TestNavigationService {
  return new TestNavigationServiceImpl(
    createNavigationService({ initialRoute: options?.initialRoute }),
  )
}
