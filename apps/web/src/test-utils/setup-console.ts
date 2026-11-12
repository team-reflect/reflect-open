import failOnConsole from 'vitest-fail-on-console'

const ALLOWED_CONSOLE_PATTERNS: RegExp[] = [
  /^(?:Error: )?ResizeObserver loop completed with undelivered notifications/,
]

failOnConsole({
  shouldFailOnWarn: true,
  shouldFailOnError: true,
  silenceMessage: (message) => ALLOWED_CONSOLE_PATTERNS.some((pattern) => pattern.test(message)),
})
