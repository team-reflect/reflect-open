import { act as reactAct } from 'react'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let activeActs = 0
let outerEnvironment: boolean | undefined

/**
 * React's `act` for browser tests. React only accepts `act` while
 * `IS_REACT_ACT_ENVIRONMENT` is set, and the flag cannot stay on: with it on,
 * every update from a real browser event warns that it was not wrapped in
 * `act`. So the flag is on while an `act` scope is open, and the outermost
 * scope restores the value it found when it ends.
 *
 * Tests import this instead of `act` from `react`.
 */
export async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  if (activeActs === 0) {
    outerEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  }
  activeActs++
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    return await reactAct(async () => await callback())
  } finally {
    activeActs--
    if (activeActs === 0) {
      globalThis.IS_REACT_ACT_ENVIRONMENT = outerEnvironment
    }
  }
}
