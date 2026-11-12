import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Route } from '@reflect/app'
import {
  buildNoChromeState,
  buildShellChromeState,
  type ShellChromeInput,
} from '@/mobile/native-chrome/native-chrome-state.ts'

/**
 * The Swift tests decode the same files (`ChromeKitTests`), so a field that
 * one side renames fails on the other. `UPDATE_CHROME_FIXTURES=1` rewrites
 * them.
 */
const FIXTURES = join(import.meta.dirname, '../../../../../apple/Tests/ChromeKitTests/Fixtures')

const BASE: Omit<ShellChromeInput, 'route' | 'tab'> = {
  entryId: 7,
  bar: undefined,
  keyboardVisible: false,
  modal: false,
  toolbar: null,
  theme: 'system',
}

function checkFixture(name: string, state: object): void {
  const path = join(FIXTURES, `${name}.json`)
  const json = `${JSON.stringify({ ...state, generation: 1 }, null, 2)}\n`
  if (process.env.UPDATE_CHROME_FIXTURES === '1') {
    writeFileSync(path, json)
  }
  expect(readFileSync(path, 'utf8')).toBe(json)
}

describe('buildShellChromeState', () => {
  it('shows the month menu and the gear of Daily', () => {
    const state = buildShellChromeState({
      ...BASE,
      route: { kind: 'today' },
      tab: 'daily',
      bar: {
        title: 'November 2026',
        titleMenu: [
          { type: 'action', id: 'month:2026-11', title: 'November 2026', checked: true },
          {
            type: 'section',
            items: [{ type: 'action', id: 'monthPicker', title: 'Choose Month…' }],
          },
        ],
        leading: [{ id: 'today', title: 'Today' }],
        trailing: [{ id: 'settings', title: 'Settings', icon: 'gearshape' }],
      },
    })
    expect(state).toMatchObject({ canBack: false, showsBar: true })
    checkFixture('daily', state)
  })

  it('has no title for a note until its screen names it', () => {
    const route: Route = { kind: 'note', path: 'ideas.md' }
    const state = buildShellChromeState({ ...BASE, route, tab: 'all' })
    expect(state).toMatchObject({ title: null, canBack: true })
  })

  it('carries the note menu and a confirmation', () => {
    const state = buildShellChromeState({
      ...BASE,
      route: { kind: 'note', path: 'ideas.md' },
      tab: 'daily',
      bar: {
        title: 'Ideas',
        trailing: [
          {
            id: 'actions',
            title: 'Note actions',
            icon: 'ellipsis',
            menu: [
              { type: 'action', id: 'pin', title: 'Pin', icon: 'pin' },
              {
                type: 'section',
                items: [
                  {
                    type: 'action',
                    id: 'delete',
                    title: 'Delete',
                    icon: 'trash',
                    destructive: true,
                    confirm: { title: 'Delete this note?', action: 'Delete' },
                  },
                ],
              },
            ],
          },
        ],
      },
      keyboardVisible: true,
      toolbar: {
        canIndent: true,
        canDedent: false,
        canMoveUp: true,
        canMoveDown: false,
        canAttachFiles: true,
      },
      theme: 'dark',
    })
    checkFixture('note', state)
  })

  it('leaves All and Tasks to their web search header', () => {
    for (const route of [
      { kind: 'allNotes', tag: null },
      { kind: 'search', query: 'x' },
      { kind: 'tasks' },
    ] satisfies Route[]) {
      expect(buildShellChromeState({ ...BASE, route, tab: 'all' }).showsBar).toBe(false)
    }
    checkFixture(
      'tasks',
      buildShellChromeState({ ...BASE, route: { kind: 'tasks' }, tab: 'tasks' }),
    )
  })
})

describe('buildNoChromeState', () => {
  it('shows no bars', () => {
    const state = buildNoChromeState('light')
    expect(state).toMatchObject({ chrome: 'none', showsBar: false, route: null })
    checkFixture('none', state)
  })
})
