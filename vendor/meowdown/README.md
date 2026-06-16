# Meowdown master builds

These tarballs are built from `prosekit/meowdown` commit
`2fa5d142b09c24a518620ff9dbc55c3c90a4fb3d`.

The upstream packages publish compiled `dist/` files to npm, but the GitHub source
tree only contains `src/` and its package `files` whitelist omits those sources
when installed directly from a git subdirectory. Keeping the built tarballs here
lets Reflect pin to that exact upstream master revision while preserving normal
package exports and TypeScript declarations.
