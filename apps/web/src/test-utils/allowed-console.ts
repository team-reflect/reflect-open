// Console output that tests may produce without failing. App output never
// belongs here: the app logs through `LoggerService`, and the test services'
// logger records instead of printing. Tests call `act` from
// `@/test-utils/act.ts`, so React's act-environment warning does not either.
// A new entry needs a stated, measured reason.
//
// The one entry is a browser artifact with no app code on its stack. `virtua`
// measures rows from its own `ResizeObserver`; when an imperative scroll
// (`scrollToIndex`) lands in the same frame, Chromium cannot deliver every
// notification in that frame, defers the rest to the next one, and reports it
// as a `window` error event with no `error` object. Vitest's browser error
// catcher prints such an event with `console.error` instead of failing the
// test. Measured: `components/daily-stream.focus.test.tsx` prints it in 20 of
// 20 runs (the two tests that navigate before the target row exists); no
// other file in the browser project prints it.
export const ALLOWED_CONSOLE_PATTERNS: RegExp[] = [
  /^(?:Error: )?ResizeObserver loop completed with undelivered notifications/,
]
