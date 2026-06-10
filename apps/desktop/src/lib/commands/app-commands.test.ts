import { describe, expect, it, vi } from 'vitest'
import type { EmbedStatus } from '@reflect/core'
import type { Route } from '@/routing/route'
import { resetOperations } from '@/lib/operations'
import type { CommandContext } from './types'

const randomNotePath = vi.hoisted(() => vi.fn())
const rebuildIndex = vi.hoisted(() => vi.fn())
const embedStatus = vi.hoisted(() =>
  vi.fn<() => Promise<EmbedStatus>>(async () => ({ status: 'uninitialized' })),
)
const backfillEmbeddingsVisibly = vi.hoisted(() => vi.fn(async () => 'completed'))
const toggleNotePinned = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/semantic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/semantic')>()),
  backfillEmbeddingsVisibly,
}))
vi.mock('@/lib/note-pin', () => ({ toggleNotePinned }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  randomNotePath,
  rebuildIndex,
  embedStatus,
}))

// Importing registers the commands (module side effect, like production).
const { APP_COMMANDS, keybindingFor } = await import('./app-commands')

function command(id: string) {
  const found = APP_COMMANDS.find((entry) => entry.id === id)
  if (!found) {
    throw new Error(`no such command: ${id}`)
  }
  return found
}

function fakeContext(overrides?: Partial<CommandContext>) {
  const navigated: Route[] = []
  const context: CommandContext = {
    navigate: (route) => void navigated.push(route),
    route: () => ({ kind: 'today' }),
    back: vi.fn(),
    forward: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    generation: () => 7,
    openPalette: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...overrides,
  }
  return { context, navigated }
}

describe('keybindingFor', () => {
  it('returns the binding UI hints derive from', () => {
    expect(keybindingFor('nav.today')).toBe('Mod-d')
    expect(keybindingFor('palette.open')).toBe('Mod-k')
  })

  it('returns null for unbound commands and unknown ids', () => {
    expect(keybindingFor('theme.toggle')).toBeNull() // a real command, no binding
    expect(keybindingFor('no.such.command')).toBeNull()
  })
})

describe('app commands', () => {
  it('nav.today, history, palette, theme, and sidebar commands hit their capabilities', async () => {
    const { context, navigated } = fakeContext()
    await command('nav.today').run(context)
    expect(navigated).toEqual([{ kind: 'today' }])
    await command('history.back').run(context)
    expect(context.back).toHaveBeenCalled()
    await command('history.forward').run(context)
    expect(context.forward).toHaveBeenCalled()
    await command('palette.open').run(context)
    expect(context.openPalette).toHaveBeenCalled()
    await command('theme.toggle').run(context)
    expect(context.toggleTheme).toHaveBeenCalled()
    await command('sidebar.toggle').run(context)
    expect(context.toggleSidebar).toHaveBeenCalled()
  })

  it('settings.open navigates to the settings screen', async () => {
    const { context, navigated } = fakeContext()
    await command('settings.open').run(context)
    expect(navigated).toEqual([{ kind: 'settings' }])
  })

  it('note.new navigates to a fresh lazy ULID note path', async () => {
    const { context, navigated } = fakeContext()
    await command('note.new').run(context)
    expect(navigated).toHaveLength(1)
    const route = navigated[0]
    expect(route.kind).toBe('note')
    expect((route as { kind: 'note'; path: string }).path).toMatch(/^notes\/[0-9a-z]+\.md$/)
  })

  it('note.random navigates to the picked note and no-ops on an empty graph', async () => {
    const { context, navigated } = fakeContext()
    randomNotePath.mockResolvedValueOnce('notes/lucky.md')
    await command('note.random').run(context)
    expect(navigated).toEqual([{ kind: 'note', path: 'notes/lucky.md' }])

    randomNotePath.mockResolvedValueOnce(null)
    await command('note.random').run(context)
    expect(navigated).toHaveLength(1) // unchanged
  })

  it('note.togglePin flips the pin of the note the route edits', async () => {
    toggleNotePinned.mockClear()
    const { context } = fakeContext({ route: () => ({ kind: 'note', path: 'notes/a.md' }) })
    await command('note.togglePin').run(context)
    expect(toggleNotePinned).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('note.togglePin targets the daily file on daily/today routes', async () => {
    toggleNotePinned.mockClear()
    const { context } = fakeContext({ route: () => ({ kind: 'daily', date: '2026-06-09' }) })
    await command('note.togglePin').run(context)
    expect(toggleNotePinned).toHaveBeenCalledWith('daily/2026-06-09.md', 7)
  })

  it('note.togglePin reports a failed toggle as an operation, never an unhandled throw', async () => {
    try {
      toggleNotePinned.mockClear()
      toggleNotePinned.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
      const { context } = fakeContext({ route: () => ({ kind: 'note', path: 'notes/a.md' }) })
      // runCommand has no error channel — the command must absorb and report.
      await expect(command('note.togglePin').run(context)).resolves.toBeUndefined()
    } finally {
      resetOperations()
    }
  })

  it('note.togglePin no-ops on note-less routes and without a graph', async () => {
    toggleNotePinned.mockClear()
    const { context } = fakeContext({ route: () => ({ kind: 'settings' }) })
    await command('note.togglePin').run(context)
    const { context: noGraph } = fakeContext({ generation: () => null })
    await command('note.togglePin').run(noGraph)
    expect(toggleNotePinned).not.toHaveBeenCalled()
  })

  it('semantic.enable persists the opt-in through the context capability', async () => {
    const { context } = fakeContext()
    await command('semantic.enable').run(context)
    // EmbeddingsSync owns the download reaction; the command only opts in.
    expect(context.enableSemanticSearch).toHaveBeenCalled()
  })

  it('index.rebuild runs at the open generation and reports as an operation', async () => {
    try {
      rebuildIndex.mockResolvedValueOnce(undefined)
      const { context } = fakeContext()
      await command('index.rebuild').run(context)
      expect(rebuildIndex).toHaveBeenCalledWith({ generation: 7 })

      // No graph open → no rebuild.
      rebuildIndex.mockClear()
      const { context: noGraph } = fakeContext({ generation: () => null })
      await command('index.rebuild').run(noGraph)
      expect(rebuildIndex).not.toHaveBeenCalled()
    } finally {
      resetOperations()
    }
  })

  it('index.rebuild re-runs the embedding backfill when the model is ready', async () => {
    try {
      rebuildIndex.mockResolvedValueOnce(undefined)
      embedStatus.mockResolvedValueOnce({ status: 'ready', model: 'all-MiniLM-L6-v2' })
      const { context } = fakeContext()
      await command('index.rebuild').run(context)
      // index_clear wiped the embedding tables; rebuild must repopulate them.
      expect(backfillEmbeddingsVisibly).toHaveBeenCalledWith({
        generation: 7,
        modelId: 'all-MiniLM-L6-v2',
      })
    } finally {
      resetOperations()
    }
  })
})
