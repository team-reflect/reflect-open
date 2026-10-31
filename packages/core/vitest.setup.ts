import failOnConsole from 'vitest-fail-on-console'

// Core logs through `LoggerService`, and the test logger records instead of
// printing. So any `console.warn` / `console.error` in a core test is a leak:
// production code that bypasses the logger, or a dependency that prints.
//
// The package's declarations use an extensionless relative import, which the
// `NodeNext` resolution of this package cannot follow, so the call is untyped.
// eslint-disable-next-line @typescript-eslint/no-unsafe-call
failOnConsole({
  shouldFailOnWarn: true,
  shouldFailOnError: true,
})
