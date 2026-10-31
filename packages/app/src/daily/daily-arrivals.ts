/**
 * One router arrival as the daily surface sees it.
 */
export interface DailyArrival {
  /**
   * The router's navigation counter, bumped on every `navigate`.
   */
  seq: number
  /**
   * The daily route's shown day (ISO date).
   */
  date: string
}

/**
 * What the daily surface does about an arrival.
 */
export interface DailyArrivalIntent {
  /**
   * `request` focuses the arrival's day with the caret at its end, `clear`
   * drops a pending focus request, and `keep` leaves it as it is.
   */
  focus: 'request' | 'clear' | 'keep'
  /**
   * True when the selected slide re-anchors to the top and the strip re-centers.
   */
  reanchor: boolean
}

/**
 * Turns one step of the router's arrival stream into the daily surface's two
 * intents: re-anchor (a date-preserving re-arrival) and focus (a capture
 * arrival, `navigate(..., { focusEditor: true })`). The router bumps the seq
 * for every navigate, but a swipe's own echo also changes the date, so only
 * date-preserving arrivals re-anchor.
 */
export function dailyArrivalIntent(
  last: DailyArrival,
  next: DailyArrival,
  focusEditor: boolean,
): DailyArrivalIntent {
  const arrived = next.seq !== last.seq
  return {
    focus: arrived ? (focusEditor ? 'request' : 'clear') : 'keep',
    reanchor: arrived && next.date === last.date,
  }
}
