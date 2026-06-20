#!/usr/bin/env node
//
// Merges the baseline/head benchmark artifacts into a single summary table.
// Usage: node bench/summarize.mjs <artifacts-dir>
// Writes <artifacts-dir>/summary.json and prints a Markdown table to stdout.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: node bench/summarize.mjs <artifacts-dir>')
  process.exit(1)
}

/** The headline metric per flow: the re-render / rerun / allocation count. */
const HEADLINE = {
  'flow-2-daily-stream-scroll': 'rerenderNotePaneRenders',
  'flow-4a-palette-snippet-typing': 'typingParseHighlightsCalls',
  'flow-4b-palette-preview-nav': 'mountsDuringArrows',
  'flow-5a-sidebar-pinned': 'rerenderRowRenders',
  'flow-5b-day-calendar-set': 'rerenderSetBuilds',
  'flow-5c-similar-notes-stability': 'distinctResultReferences',
}

const LABEL = {
  'flow-2-daily-stream-scroll': 'Daily-stream scroll — NotePane re-renders avoided',
  'flow-4a-palette-snippet-typing': 'Palette typing — parseHighlights reruns',
  'flow-4b-palette-preview-nav': 'Palette ↓ nav — NotePreview remounts',
  'flow-5a-sidebar-pinned': 'Sidebar route change — pinned-row re-renders',
  'flow-5b-day-calendar-set': 'Calendar re-render — noted-Set allocations',
  'flow-5c-similar-notes-stability': 'Similar-notes — distinct array refs / renders',
}

function readRev(rev) {
  const dir = join(outDir, rev)
  const byFlow = {}
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file === 'summary.json') continue
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    byFlow[data.flow] = data
  }
  return byFlow
}

const baseline = readRev('baseline')
const head = readRev('head')

const rows = []
for (const flow of Object.keys(HEADLINE)) {
  const metric = HEADLINE[flow]
  const before = baseline[flow]?.metrics?.[metric]
  const after = head[flow]?.metrics?.[metric]
  rows.push({ flow, label: LABEL[flow], metric, before, after })
}

const summary = {
  generatedAt: process.env.BENCH_STAMP ?? null,
  baselineRev: Object.values(baseline)[0]?.rev ?? 'baseline',
  headRev: Object.values(head)[0]?.rev ?? 'head',
  rows,
  raw: { baseline, head },
}
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

const pad = (value, width) => String(value).padEnd(width)
console.log('\n| Flow | Headline metric | Before (pre-memo) | After (memoized) |')
console.log('|---|---|---|---|')
for (const row of rows) {
  console.log(
    `| ${pad(row.label, 48)} | ${pad(row.metric, 28)} | ${pad(row.before ?? 'n/a', 8)} | ${pad(row.after ?? 'n/a', 8)} |`,
  )
}
console.log('')
