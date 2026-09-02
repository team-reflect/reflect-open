/**
 * The origins X bookmark capture runs on (Plan 25). Dependency-free so the
 * WXT config can read it at build time as well as the extension at runtime.
 * `twitter.com` still redirects to `x.com`, but a bookmark made before the
 * redirect lands must be watchable too.
 */
export const X_ORIGINS = ['*://x.com/*', '*://twitter.com/*'] as const
