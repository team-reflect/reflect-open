import { act as reactAct } from 'react'

/**
 * `act()` for the browser test project.
 *
 * `vitest-browser-react` drives `IS_REACT_ACT_ENVIRONMENT` with an internal
 * counter and flips it back off once its own render/cleanup finishes, so a bare
 * `act()` from `react` (used by hook tests to flush imperative updates) runs
 * with the flag off and React logs "not configured to support act(...)". Flag
 * the environment around each call, the way `@testing-library/react` does under
 * jsdom, then restore it. Like React's `act`, it resolves to the callback's
 * value so a hook test can read what an imperative call returned.
 */
export function act<T>(callback: () => T | Promise<T>): Promise<T> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }
  const previous = env.IS_REACT_ACT_ENVIRONMENT
  env.IS_REACT_ACT_ENVIRONMENT = true
  return Promise.resolve(reactAct(callback as () => Promise<T>)).finally(() => {
    env.IS_REACT_ACT_ENVIRONMENT = previous
  })
}
