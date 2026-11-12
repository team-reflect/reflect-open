import { z } from 'zod'
import type { Route } from '@reflect/app'
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
      /** The menu stays open after a tap, for several toggles in a row. */
      keepsMenuPresented?: boolean | undefined
      confirm?: NativeConfirm | undefined
    }
  | {
      type: 'section'
      title?: string | undefined
      items: NativeMenuItem[]
    }

/**
 * A button of the native navigation bar. A tap opens `menu` when it has
 * one, and sends an `action` intent with `id` otherwise.
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
  route: Route | null
  tab: MobileTab
  canBack: boolean
  /** The navigation bar title, or `null` while it is not known yet. */
  title: string | null
  /** A menu on the title (the Daily month menu). */
  titleMenu: NativeMenuItem[] | null
  /** Whether the page wants the native navigation bar. */
  showsBar: boolean
  leading: NativeBarButton[]
  trailing: NativeBarButton[]
  keyboardVisible: boolean
  /** A web drawer is open: the shell hides its bars. */
  modal: boolean
  toolbar: NativeToolbarState | null
  theme: 'system' | 'light' | 'dark'
}

/**
 * A rectangle in CSS pixels of the web view.
 */
export interface NativeRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Every message the page posts to the shell.
 */
export type NativeChromeMessage =
  | NativeChromeState
  | {
      type: 'presentMenu'
      entryId: number
      menuId: string
      rect: NativeRect
      items: NativeMenuItem[]
    }
  | { type: 'transition'; phase: 'start' | 'end' }
  | { type: 'chromeReady' }

const tabSchema = z.enum(['daily', 'all', 'tasks'])

const fileSchema = z.object({ name: z.string(), type: z.string(), data: z.string() })

const intentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('back'), entryId: z.number() }),
  z.object({ type: z.literal('tab'), tab: tabSchema }),
  z.object({ type: z.literal('action'), entryId: z.number(), id: z.string() }),
  z.object({ type: z.literal('menu'), entryId: z.number(), menuId: z.string(), id: z.string() }),
  z.object({ type: z.literal('command'), id: z.string() }),
  z.object({ type: z.literal('files'), files: z.array(fileSchema) }),
])

/**
 * What a native control asks the page to do.
 */
export type NativeIntent = z.infer<typeof intentSchema>

/**
 * The intent in a `chrome:intent` payload, or `null` for anything else.
 */
export function parseNativeIntent(payload: unknown): NativeIntent | null {
  const parsed = intentSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}
