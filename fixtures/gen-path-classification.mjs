// Regenerates graph-path-classification.json, the corpus pinned by BOTH
// classifiers (crates/graph-paths and packages/core/src/graph/paths.ts).
//
//   node fixtures/gen-path-classification.mjs
//
// The `expected` function below is a third, deliberately naive expression of
// the policy — the spec the two production classifiers must agree with. A
// hand-picked seed list keeps the regression cases readable; the generated
// matrix sweeps the mutations no one thinks to hand-pick (case variants,
// Unicode confusables, separator garbage) so the corpus can't silently
// under-cover what the implementations differ on.

const RESERVED = new Set(['assets', 'audio-memos'])
const ATTACHMENTS = new Set([
  '3gp', 'avif', 'bmp', 'flac', 'gif', 'jpeg', 'jpg', 'm4a', 'mkv', 'mov',
  'mp3', 'mp4', 'ogg', 'ogv', 'pdf', 'png', 'svg', 'wav', 'webm', 'webp',
])

// ASCII-only lowering — the shared policy never folds beyond ASCII.
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

function expected(path) {
  if (path === '' || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) {
    return null
  }
  const components = path.split('/')
  if (!components.every((c) => c !== '' && !c.startsWith('.'))) {
    return null
  }
  const first = components[0]
  const filename = components.at(-1)
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) {
    return null
  }
  const extension = filename.slice(dot + 1)
  if (extension === 'md' && !RESERVED.has(asciiLower(first))) {
    return 'note'
  }
  return ATTACHMENTS.has(asciiLower(extension)) ? 'attachment' : null
}

/** Hand-picked regressions, kept verbatim for readability in review. */
const SEEDS = [
  'README.md',
  'Projects/Plan.md',
  'Projects/Deep/Unicode-台北.md',
  'Projects/İstanbul.md',
  'Projects/Encoded%20Name.md',
  'daily/2026-07-14.md',
  'templates/Meeting.md',
  'Notes/Sub/deep.md',
  'UPPER.MD',
  'note.markdown',
  '.hidden.md',
  'Projects/.plan.md.icloud',
  '.obsidian/note.md',
  'Projects/.private/note.md',
  'assets/caption.md',
  'Assets/caption.md',
  'audio-memos/transcript.md',
  'AUDIO-MEMOS/transcript.md',
  '../outside.md',
  'Projects/../outside.md',
  'Projects/./note.md',
  'Projects//note.md',
  'Projects/note.md/',
  'Projects\\note.md',
  '/absolute.md',
  'C:/absolute.md',
  'C:relative.md',
  'assets/photo.png',
  'Media/PHOTO.JPEG',
  'Media/clip.MP4',
  'Media/clip.m\u212Av',
  'audio-memos/memo.m4a',
  'Documents/reference.pdf',
  'Documents/archive.zip',
  '.assets/photo.png',
  'Media/.private/photo.png',
]

/** The generated sweep: directories × stems × extension mutations. */
const DIRS = ['', 'notes/', 'daily/', 'templates/', 'Projects/deep/', 'assets/', 'Assets/', 'aSSets/', 'audio-memos/', '.hidden/', 'notes/.private/']
const STEMS = ['note', 'İstanbul', 'K-kelvin', 'trailing.', 'no']
const EXTS = [
  'md', 'MD', 'mD', 'md ', 'markdown', 'txt', '',
  'png', 'PNG', 'jPeG', 'm\u212Av', 'mkv', 'M4A', 'pdf', 'svg', 'zip',
]

const paths = new Set(SEEDS)
for (const dir of DIRS) {
  for (const stem of STEMS) {
    for (const ext of EXTS) {
      paths.add(`${dir}${stem}.${ext}`)
    }
  }
}

const rows = [...paths].map((path) => ({ path, kind: expected(path) }))
const json = `[\n${rows.map((row) => `  ${JSON.stringify(row.path)}`).map((p, i) => `{ "path": ${p.trim()}, "kind": ${JSON.stringify(rows[i].kind)} }`).map((line) => `  ${line}`).join(',\n')}\n]\n`

const { writeFileSync } = await import('node:fs')
const target = new URL('./graph-path-classification.json', import.meta.url)
writeFileSync(target, json)
console.log(`wrote ${rows.length} cases to ${target.pathname}`)
