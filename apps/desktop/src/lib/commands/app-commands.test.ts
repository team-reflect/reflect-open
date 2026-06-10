import { describe, expect, it, vi } from 'vitest'
import type { Route } from '@/routing/route'
import { resetOperations } from '@/lib/operations'
import type { CommandContext } from './types'

const randomNotePath = vi.hoisted(() => vi.fn())
const rebuildIndex = vi.hoisted(() => vi.fn())
const ensureEmbeddingsVisibly = vi.hoisted(() => vi.fn(async () => ({ status: 'ready', model: 'm' })))
const setSemanticEnabled = vi.hoisted(() => vi.fn())
vi.mock('@/lib/semantic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/semantic')>()),
  ensureEmbeddingsVisibly,
  setSemanticEnabled,
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  randomNotePath,
  rebuildIndex,
}))

// Importing registers the commands (module side effect, like production).
const { APP_COMMANDS } = await import('./app-commands')

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
    back: vi.fn(),
    forward: vi.fn(),
    toggleTheme: vi.fn(),
    generation: () => 7,
    openPalette: vi.fn(),
    ...overrides,
  }
  return { context, navigated }
}

describe('app commands', () => {
  it('nav.today, history, palette, and theme commands hit their capabilities', async () => {
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

  it('semantic.enable persists the opt-in and loads the model visibly', async () => {
    const { context } = fakeContext()
    await command('semantic.enable').run(context)
    expect(setSemanticEnabled).toHaveBeenCalledWith(true)
    expect(ensureEmbeddingsVisibly).toHaveBeenCalled()
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
})
