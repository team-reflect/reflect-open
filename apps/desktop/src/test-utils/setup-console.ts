import failOnConsole from 'vitest-fail-on-console'
import { ALLOWED_CONSOLE_PATTERNS } from './allowed-console'

failOnConsole({
  shouldFailOnWarn: true,
  shouldFailOnError: true,
  silenceMessage: (message) => ALLOWED_CONSOLE_PATTERNS.some((pattern) => pattern.test(message)),
})
