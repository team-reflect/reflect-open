import { buildDataset } from '../../lib/dataset'

const dataset = buildDataset()

/** Fixed large result set — no search IPC. Browser-harness only. */
export function usePaletteResults(): {
  sections: { notes: typeof dataset.paletteNotes; commands: never[]; commandsOnly: boolean }
  resultsSettled: boolean
  searchFailed: boolean
} {
  return {
    sections: { notes: dataset.paletteNotes, commands: [], commandsOnly: false },
    resultsSettled: true,
    searchFailed: false,
  }
}
