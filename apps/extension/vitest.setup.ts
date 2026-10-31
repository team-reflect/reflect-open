import failOnConsole from 'vitest-fail-on-console'

// Any `console.warn` / `console.error` in an extension test fails it. A test
// that expects one spies on the method and asserts on the call.
failOnConsole({
  shouldFailOnWarn: true,
  shouldFailOnError: true,
})
