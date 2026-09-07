# @reflect/modules

Re-export modules for the npm packages that the app loads on demand with a dynamic `import()`.

Why not `await import('ai')` directly: when the bundler sees a dynamic import of a whole package, it keeps every export of that package in the lazy chunk, because it cannot tell which ones the caller will read from the namespace object. Importing a module that statically re-exports only the APIs we use lets the bundler tree-shake the rest. Measured on the desktop build, the `ai` chunk went from 340 KB to 231 KB.

Rules:

- One file per npm package, named after the package (`src/ai.ts` for `ai`, `src/ai-sdk/anthropic.ts` for `@ai-sdk/anthropic`), exported as a subpath with the same shape (`@reflect/modules/ai-sdk/anthropic`).
- Re-export only what the app calls, plus the types it needs.
- This package is the only place these npm packages are listed as dependencies.
- Consumers load it with `await import('@reflect/modules/ai')` and take types with `import type { ... } from '@reflect/modules/ai'`.
