// Console noise that predates fail-on-console, silenced so the check could
// land. PRs may only shrink this list; a new entry needs a stated reason.
export const ALLOWED_CONSOLE_PATTERNS: RegExp[] = [
  /^window label unavailable; assuming the main window:/,
  /^index: stored projection version /,
  /^failed to save note:/,
  /^stored-facts prefetch failed; applying the batch without skips:/,
  /^reading a native-stopped recording failed:/,
  /^note file move failed:/,
  /^Index rebuild skipped /,
  /^iCloud conflict sweep failed:/,
  /^haptics unavailable:/,
  /^chat graph context failed:/,
  /^An empty string \(""\) was passed to the src attribute/,
  /^The current testing environment is not configured to support act/,
  /^the native-action handshake is unavailable:/,
  /^index sync failed:/,
]
