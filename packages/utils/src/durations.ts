import prettyMs from 'pretty-ms'

/** An elapsed time as `m:ss` under an hour and `h:mm:ss` from there. */
export function formatElapsed(ms: number): string {
  return prettyMs(ms, { colonNotation: true, secondsDecimalDigits: 0, hideYearAndDays: true })
}

/** A duration in whole seconds and words, such as `2 minutes` or `0 seconds`. */
export function formatDurationInWords(ms: number): string {
  // pretty-ms words anything under a second in milliseconds.
  const seconds = Math.floor(Math.max(ms, 0) / 1000)
  return seconds === 0 ? '0 seconds' : prettyMs(seconds * 1000, { compact: true, verbose: true })
}
