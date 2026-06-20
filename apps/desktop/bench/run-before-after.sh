#!/usr/bin/env bash
#
# Runs the performance-pass benchmark suite twice — once at HEAD (memoized) and
# once with the five touched source files checked out at the pre-memo parent
# commit — and writes machine-readable artifacts under
# docs/performance-pass-20260620/artifacts/{head,baseline}/.
#
# The harness and dataset are byte-identical across both runs, so any delta is
# attributable solely to the memoizations. A trap restores the working tree on
# any exit. Benchmark-only; touches no production code.
set -euo pipefail

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO/apps/desktop"
OUT="$REPO/docs/performance-pass-20260620/artifacts"
BASELINE_REV="${BASELINE_REV:-7225f2e}"

FILES=(
  apps/desktop/src/components/note-pane.tsx
  apps/desktop/src/components/command-palette/command-palette.tsx
  apps/desktop/src/components/sidebar/sidebar-note-row.tsx
  apps/desktop/src/components/context-sidebar/day-calendar.tsx
  apps/desktop/src/lib/use-similar-notes.ts
)

BENCH=(
  bench/note-pane.bench.test.tsx
  bench/command-palette.bench.test.tsx
  bench/sidebar-note-row.bench.test.tsx
  bench/day-calendar.bench.test.tsx
  bench/use-similar-notes.bench.test.tsx
)

# Refuse to run if the touched files are dirty — the trap restores to HEAD.
if ! git -C "$REPO" diff --quiet -- "${FILES[@]}"; then
  echo "error: touched source files have uncommitted changes; commit or stash first." >&2
  exit 1
fi

restore() {
  git -C "$REPO" checkout HEAD -- "${FILES[@]}"
  echo "restored touched files to HEAD."
}
trap restore EXIT

echo "==> Running suite at HEAD (memoized)…"
BENCH_REV=head BENCH_OUT="$OUT" npx vitest run "${BENCH[@]}"

echo "==> Checking out the five touched files at ${BASELINE_REV} (pre-memo)…"
git -C "$REPO" checkout "$BASELINE_REV" -- "${FILES[@]}"

echo "==> Running suite at baseline (pre-memo)…"
BENCH_REV=baseline BENCH_OUT="$OUT" npx vitest run "${BENCH[@]}"

# restore runs via trap
echo "==> Summarising…"
node bench/summarize.mjs "$OUT"
