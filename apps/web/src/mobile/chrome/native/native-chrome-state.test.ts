import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { noop } from '@ocavue/utils'
import { describe, expect, it } from 'vitest'
import type { Route } from '@reflect/app'
import {
  buildNoChromeState,
  buildShellChromeState,
  toWireTitle,
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
  sidebar: null,
  history: null,
  fullscreen: false,
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
        hidesTabBar: false,
        leading: [{ id: 'settings', title: 'Settings', icon: 'settings' }],
        trailing: [
          { id: 'today', title: 'Today' },
          { id: 'hidden', title: 'Hidden', hidden: true },
        ],
        plus: { kind: 'capture', audio: 'idle' },
        title: { kind: 'month', text: 'November 2026', month: '2026-11' },
        search: null,
      },
      sidebar: {
        selection: 'pinned:reflect-v2.md',
        pinned: [{ path: 'reflect-v2.md', title: 'Reflect V2' }],
        graphName: 'My Graph',
        graphColor: '#3b82f6',
        graphMenu: [{ type: 'action', id: 'graphs', title: 'Switch Graph…' }],
      },
      history: { back: true, forward: false },
    })
    expect(state).toMatchObject({ canBack: false })
    checkFixture('daily', state)
  })

  it('shows the back button on a pushed screen', () => {
    const route: Route = { kind: 'note', path: 'ideas.md' }
    const bar = {
      canBack: true,
      hidesTabBar: false,
      leading: [],
      trailing: [],
      plus: null,
      title: null,
      search: null,
    }
    const state = buildShellChromeState({ ...BASE, route, tab: 'all', bar })
    expect(state).toMatchObject({ canBack: true, leading: [], trailing: [], hidesTabBar: false })
  })

  it('hides the tab bar of a screen that asks for it', () => {
    const route: Route = { kind: 'settings', page: 'main' }
    const bar = {
      canBack: true,
      hidesTabBar: true,
      leading: [],
      trailing: [],
      plus: null,
      title: { kind: 'text', text: 'Settings' } as const,
      search: null,
    }
    expect(buildShellChromeState({ ...BASE, route, tab: 'daily', bar })).toMatchObject({
      hidesTabBar: true,
    })
  })

  it('carries the note menu and a confirmation', () => {
    const state = buildShellChromeState({
      ...BASE,
      route: { kind: 'note', path: 'ideas.md' },
      tab: 'daily',
      bar: {
        canBack: true,
        hidesTabBar: false,
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
        plus: null,
        title: { kind: 'text', text: 'Edit note' },
        search: null,
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

  it('carries the title of a screen', () => {
    expect(toWireTitle('Settings')).toEqual({ kind: 'text', text: 'Settings' })
    expect(
      toWireTitle({
        kind: 'month',
        month: '2026-12',
        selected: '2026-11',
        today: '2026-11',
        onPick: noop,
      }),
    ).toEqual({ kind: 'month', text: 'December 2026', month: '2026-11' })
  })

  it('shows no corner buttons on All and Tasks without a bar', () => {
    for (const route of [{ kind: 'allNotes', tag: null }, { kind: 'tasks' }] satisfies Route[]) {
      expect(buildShellChromeState({ ...BASE, route, tab: 'all' })).toMatchObject({
        canBack: false,
        leading: [],
        trailing: [],
      })
    }
    checkFixture(
      'tasks',
      buildShellChromeState({
        ...BASE,
        route: { kind: 'tasks' },
        tab: 'tasks',
        bar: {
          canBack: false,
          hidesTabBar: false,
          leading: [],
          trailing: [{ id: 'filters', title: 'Task filters', icon: 'filters' }],
          plus: { kind: 'action', label: 'New task' },
          title: null,
          search: { placeholder: 'Search tasks…', label: 'Search tasks', text: '', revision: 0 },
        },
      }),
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
      { type: 'backSwipe', phase: 'start' },
      { type: 'backSwipe', phase: 'cancel' },
      { type: 'chromeReady' },
      { type: 'focusSearch', entryId: 3 },
      { type: 'contextMenu', request: 2, items: [{ type: 'action', id: '0', title: 'Pin' }] },
    ]
    checkJSONFixture('messages', messages)
  })
})
