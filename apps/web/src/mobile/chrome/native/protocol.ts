import { z } from 'zod'
import type { Route } from '@reflect/app'
import type { AudioMemoPhase } from '@reflect/core'
import type { MobileTab } from '@/mobile/mobile-tab-bar.tsx'

/**
 * The entry id of a surface outside the router (onboarding, loading), so it
 * never matches a history entry: those start at 0 for every router.
 */
export const NO_ENTRY = -1

/**
 * A confirmation the shell shows before it sends the item's intent: an
 * action sheet (a popover on iPad) with one destructive button and Cancel.
 */
export interface NativeConfirm {
  title: string
  message?: string | undefined
  /** The label of the destructive button. */
  action: string
}

/**
 * One row of a native menu, in the order the shell shows it.
 */
export type NativeMenuItem =
  | {
      type: 'action'
      id: string
      title: string
      /** An SF Symbol name. */
      icon?: string | undefined
      destructive?: boolean | undefined
      disabled?: boolean | undefined
      /** Shows a checkmark. */
      checked?: boolean | undefined
      confirm?: NativeConfirm | undefined
    }
  | {
      type: 'section'
      title?: string | undefined
      items: NativeMenuItem[]
    }

/**
 * A native button that floats in a top corner of the page. A tap opens
 * `menu` when it has one, and sends an `action` intent with `id` otherwise.
 */
export interface NativeBarButton {
  id: string
  /** The label, also the accessibility label of an icon button. */
  title: string
  /** An SF Symbol name; without it the button shows `title`. */
  icon?: string | undefined
  menu?: NativeMenuItem[] | undefined
}

/**
 * The state of the formatting toolbar of the focused editor.
 */
export interface NativeToolbarState {
  canIndent: boolean
  canDedent: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  canAttachFiles: boolean
}

/**
 * The `+` of the screen: Daily's capture menu, which shows the audio
 * action only with a phase, or one action with an accessibility label.
 */
export type NativePlusState =
  | { kind: 'capture'; audio: AudioMemoPhase | null }
  | { kind: 'action'; label: string }

/**
 * What the iPad sidebar shows.
 */
export interface NativeSidebarState {
  /**
   * The row to select: a tab, `chat`, or a pinned note's path after `pinned:`.
   */
  selection: string
  /** The pinned notes in shelf order, with the names the sidebar shows. */
  pinned: { path: string; title: string }[]
  graphName: string
  /** The graph's color as `#rrggbb`, or `null` for the app's tint. */
  graphColor: string | null
  graphMenu: NativeMenuItem[]
}

/**
 * The chrome state the page posts after every change.
 */
export interface NativeChromeState {
  type: 'state'
  /** Grows with every state of this document. */
  generation: number
  /** The history entry the state describes; intents echo it. */
  entryId: number
  /** `none` on the surfaces outside the shell (onboarding, loading, error). */
  chrome: 'shell' | 'none'
  /** The kind of the route on screen, for the shell's logs. */
  routeKind: Route['kind'] | null
  tab: MobileTab
  /** The shell shows a back button before the `leading` buttons. */
  canBack: boolean
  /** The buttons in the top-left corner, after the back button. */
  leading: NativeBarButton[]
  /** The buttons in the top-right corner. */
  trailing: NativeBarButton[]
  keyboardVisible: boolean
  /** A web drawer is open: the shell hides its bars. */
  modal: boolean
  toolbar: NativeToolbarState | null
  /** The `+` of the screen, or `null` for a screen without one. */
  plus: NativePlusState | null
  /** What the iPad sidebar shows, or `null` outside the shell. */
  sidebar: NativeSidebarState | null
  theme: 'system' | 'light' | 'dark'
}

/**
 * Every message the page posts to the shell.
 */
export type NativeChromeMessage =
  | NativeChromeState
  | { type: 'transition'; phase: 'start' | 'end' }
  /** A user back swipe starts to move the page, or settles back without a pop. */
  | { type: 'backSwipe'; phase: 'start' | 'cancel' }
  | { type: 'chromeReady' }

/**
 * The commands of the formatting toolbar that the shell draws.
 */
export const FORMATTING_COMMANDS = [
  'slash',
  'list',
  'todo',
  'link',
  'tag',
  'dedent',
  'indent',
  'up',
  'down',
  'dismiss',
] as const

export type FormattingCommandId = (typeof FORMATTING_COMMANDS)[number]

const tabSchema = z.enum(['daily', 'all', 'tasks'])

const fileSchema = z.object({ name: z.string(), type: z.string(), data: z.string() })

const intentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('back'), entryId: z.number() }),
  z.object({ type: z.literal('tab'), tab: tabSchema }),
  z.object({ type: z.literal('action'), entryId: z.number(), id: z.string() }),
  z.object({ type: z.literal('command'), id: z.enum(FORMATTING_COMMANDS) }),
  z.object({ type: z.literal('files'), files: z.array(fileSchema) }),
  z.object({ type: z.literal('layout'), cornersInHeaderRow: z.boolean() }),
  z.object({
    type: z.literal('plus'),
    entryId: z.number(),
    command: z.enum(['tap', 'note', 'task', 'audio']),
  }),
  z.object({ type: z.literal('sidebarVisible'), visible: z.boolean() }),
  z.object({
    type: z.literal('sidebar'),
    command: z.discriminatedUnion('kind', [
      z.object({ kind: z.enum(['chat', 'search', 'settings']) }),
      z.object({ kind: z.enum(['openNote', 'unpin', 'share']), path: z.string() }),
      z.object({ kind: z.literal('menu'), id: z.string() }),
    ]),
  }),
])

/**
 * What the shell sends the page: a tap on a native control, or a change of
 * the shell's layout. `plus` is a tap on the `+` of an action screen (`tap`)
 * or on one item of the capture menu. `layout` tells whether the shell draws the corner
 * buttons in the page's header row, or in the row of the floating tab bar
 * above it. `sidebarVisible` tells whether the iPad sidebar shows, and
 * `sidebar` is a tap in it.
 */
export type NativeIntent = z.infer<typeof intentSchema>

/**
 * The intent in a `chrome:intent` payload, or `null` for anything else.
 */
export function parseNativeIntent(payload: unknown): NativeIntent | null {
  const parsed = intentSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}
