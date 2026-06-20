/**
 * Flow 1–3 — daily stream: NotePane render churn.
 *
 * One NotePane mounts per visible day; each runs four hooks
 * (useNoteDocument/useImagePersistence/useEditorAutocomplete/
 * useWikiLinkNavigation) and renders the editor subtree. The stream re-renders
 * on scroll-range changes, focus follow, settings changes, and the midnight
 * rollover. When a re-render leaves a row's props and consumed contexts
 * unchanged, `React.memo(NotePane)` should let that row bail.
 *
 * This bench mounts the REAL NotePane (the file under test) for a window of
 * daily notes from the large dataset, then forces representative parent
 * re-renders that do not change any row's props. It counts NotePane body
 * executions (one useNoteDocument call per render) and editor-subtree renders.
 * The React Compiler is active (vitest shares the production plugin), so the
 * delta reflects the memo's marginal effect on top of the compiler.
 */

import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { buildDataset } from './lib/dataset'
import { createCommitMeter, MeteredTree } from './lib/profile'
import { record } from './lib/record'

const dataset = buildDataset()
const VISIBLE_DAYS = 50
const PARENT_RERENDERS = 20

// One counter per measured quantity. useNoteDocument is the first hook in the
// NotePane body, so its call count equals NotePane render count.
const counters = { noteDocument: 0, editor: 0 }

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/bench-graph', name: 'bench', cloudSync: null, generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      dateFormat: 'mdy',
      editorMarkdownSyntax: 'always',
      editorSpellCheck: true,
      editorDefaultBullet: false,
      editorBulletAfterHeading: false,
    },
    updateSettings: () => {},
  }),
}))
vi.mock('@/editor/use-note-document', () => ({
  useNoteDocument: () => {
    counters.noteDocument += 1
    return {
      status: 'ready',
      initialContent: 'bench body',
      protected: false,
      conflict: null,
      error: null,
      sessionEpoch: 1,
      onEditorChange: () => {},
      bindEditor: (_handle: NoteEditorHandle | null) => {},
      keepMine: () => {},
      loadTheirs: () => {},
    }
  },
}))
vi.mock('@/editor/use-image-persistence', () => ({
  useImagePersistence: () => ({
    resolveImageUrl: async () => null,
    resolveImageOpenPath: async () => null,
    openImage: () => {},
    saveImage: async () => {},
    onImageSaveError: () => {},
    saveError: null,
  }),
}))
vi.mock('@/editor/use-editor-autocomplete', () => ({
  useEditorAutocomplete: () => ({ onWikilinkSearch: async () => [], onTagSearch: async () => [] }),
}))
vi.mock('@/editor/use-wiki-link-navigation', () => ({
  useWikiLinkNavigation: () => () => {},
}))
vi.mock('@/editor/note-editor', () => ({
  NoteEditor: () => {
    counters.editor += 1
    return <div data-testid="bench-editor" />
  },
}))
vi.mock('@/components/backlinks-panel', () => ({
  BacklinksPanel: () => <div data-testid="bench-backlinks" />,
}))
vi.mock('@/components/sync-conflict-notice', () => ({
  SyncConflictNotice: () => null,
}))

// Imported after the mocks are registered.
const { NotePane } = await import('@/components/note-pane')

function Stream({ paths }: { paths: readonly string[] }): ReactElement {
  const [tick, setTick] = useState(0)
  return (
    <div>
      <button type="button" data-tick={tick} onClick={() => setTick((value) => value + 1)}>
        rerender
      </button>
      {paths.map((path) => (
        <NotePane key={path} path={path} editorClassName="min-h-40" />
      ))}
    </div>
  )
}

describe('NotePane render churn (daily stream)', () => {
  it('measures body + editor-subtree renders across parent re-renders', async () => {
    counters.noteDocument = 0
    counters.editor = 0
    const paths = dataset.dailyPaths.slice(0, VISIBLE_DAYS)
    const meter = createCommitMeter()
    const view = render(
      <MeteredTree onRender={meter.onRender}>
        <Stream paths={paths} />
      </MeteredTree>,
    )

    const mountRenders = counters.noteDocument
    const mountEditorRenders = counters.editor
    expect(mountRenders).toBe(VISIBLE_DAYS)

    const button = view.getByRole('button', { name: 'rerender' })
    for (let index = 0; index < PARENT_RERENDERS; index += 1) {
      await userEvent.click(button)
    }

    const totalRenders = counters.noteDocument
    const totalEditorRenders = counters.editor
    const rerenderRenders = totalRenders - mountRenders
    const rerenderEditorRenders = totalEditorRenders - mountEditorRenders

    record({
      flow: 'flow-2-daily-stream-scroll',
      description:
        'NotePane body executions and editor-subtree renders across parent re-renders ' +
        `of a ${VISIBLE_DAYS}-day window with unchanged row props (${PARENT_RERENDERS} re-renders).`,
      metrics: {
        visibleDays: VISIBLE_DAYS,
        parentRerenders: PARENT_RERENDERS,
        mountNotePaneRenders: mountRenders,
        mountEditorRenders,
        rerenderNotePaneRenders: rerenderRenders,
        rerenderEditorRenders,
        totalNotePaneRenders: totalRenders,
        totalEditorRenders,
        profiledCommits: meter.totals.commits,
        profiledActualMs: Number(meter.totals.actualMs.toFixed(2)),
      },
    })

    view.unmount()
    expect(totalRenders).toBeGreaterThanOrEqual(mountRenders)
  })
})

afterAll(() => {
  // Surface the headline number in the run log even without artifact capture.
  // (record() is the machine-readable path.)
})
