import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Route } from '@reflect/app'
import {
  buildNoChromeState,
  buildShellChromeState,
  type ShellChromeInput,
} from '@/mobile/chrome/native/native-chrome-state.ts'
import type { NativeChromeMessage } from '@/mobile/chrome/native/protocol.ts'

/**
 * The Swift tests decode the same files (`ChromeKitTests`), so a field that
 * one side renames fails on the other. `UPDATE_CHROME_FIXTURES=1` rewrites
 * them.
 */
const FIXTURES = join(import.meta.dirname, '../../../../../../apple/Tests/ChromeKitTests/Fixtures')

const BASE: Omit<ShellChromeInput, 'route' | 'tab'> = {
  entryId: 7,
  bar: undefined,
  keyboardVisible: false,
  modal: false,
  toolbar: null,
  theme: 'system',
}

function checkFixture(name: string, state: object): void {
  checkJSONFixture(name, { ...state, generation: 1 })
}

function checkJSONFixture(name: string, value: unknown): void {
  const path = join(FIXTURES, `${name}.json`)
  const json = `${JSON.stringify(value, null, 2)}\n`
  if (process.env.UPDATE_CHROME_FIXTURES === '1') {
    writeFileSync(path, json)
  }
  expect(readFileSync(path, 'utf8')).toBe(json)
}

describe('buildShellChromeState', () => {
  it('shows the gear and the Today button of Daily, and no hidden button', () => {
    const state = buildShellChromeState({
      ...BASE,
      route: { kind: 'today' },
      tab: 'daily',
      bar: {
        canBack: false,
        leading: [{ id: 'settings', title: 'Settings', icon: 'settings' }],
        trailing: [
          { id: 'today', title: 'Today' },
          { id: 'hidden', title: 'Hidden', hidden: true },
        ],
      },
    })
    expect(state).toMatchObject({ canBack: false })
    checkFixture('daily', state)
  })

  it('shows the back button on a pushed screen', () => {
    const route: Route = { kind: 'note', path: 'ideas.md' }
    const bar = { canBack: true, leading: [], trailing: [] }
    const state = buildShellChromeState({ ...BASE, route, tab: 'all', bar })
    expect(state).toMatchObject({ canBack: true, leading: [], trailing: [] })
  })

  it('carries the note menu and a confirmation', () => {
    const state = buildShellChromeState({
      ...BASE,
      route: { kind: 'note', path: 'ideas.md' },
      tab: 'daily',
      bar: {
        canBack: true,
        leading: [],
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

  it('shows no corner buttons on All and Tasks', () => {
    for (const route of [
      { kind: 'allNotes', tag: null },
      { kind: 'search', query: 'x' },
      { kind: 'tasks' },
    ] satisfies Route[]) {
      expect(buildShellChromeState({ ...BASE, route, tab: 'all' })).toMatchObject({
        canBack: false,
        leading: [],
        trailing: [],
      })
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
    expect(state).toMatchObject({ chrome: 'none', routeKind: null })
    checkFixture('none', state)
  })
})

describe('page messages', () => {
  it('matches the messages the Swift shell decodes', () => {
    const messages: NativeChromeMessage[] = [
      { type: 'transition', phase: 'start' },
      { type: 'transition', phase: 'end' },
      { type: 'backSwipe', phase: 'start' },
      { type: 'backSwipe', phase: 'cancel' },
      { type: 'chromeReady' },
    ]
    checkJSONFixture('messages', messages)
  })
})
