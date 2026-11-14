import type { ChromeIntent, ChromeMessage, FormattingCommand } from '@reflect/types'
import { z } from 'zod'

/**
 * The entry id of a surface outside the router (onboarding, loading), so it
 * never matches a history entry: those start at 0 for every router.
 */
export const NO_ENTRY = -1

/**
 * The chrome protocol types are generated from `crates/types/src/chrome.rs`.
 */
export type {
  BarButton as NativeBarButton,
  ChromeIntent as NativeIntent,
  ChromeMessage as NativeChromeMessage,
  MenuConfirm as NativeConfirm,
  MenuItem as NativeMenuItem,
  PlusState as NativePlusState,
  SidebarState as NativeSidebarState,
  ToolbarState as NativeToolbarState,
} from '@reflect/types'

/**
 * The chrome state the page posts after every change.
 */
export type NativeChromeState = Extract<ChromeMessage, { type: 'state' }>

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
] as const satisfies readonly FormattingCommand[]

export type FormattingCommandId = (typeof FORMATTING_COMMANDS)[number]

const tabSchema = z.enum(['daily', 'all', 'tasks'])

const fileSchema = z.object({ name: z.string(), type: z.string(), data: z.string() })

// The shell is trusted; the schema keeps a malformed event from running.
const intentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('back'), entryId: z.number() }),
  z.object({
    type: z.literal('history'),
    entryId: z.number(),
    direction: z.enum(['back', 'forward']),
  }),
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
  z.object({ type: z.literal('sidebarVisible'), visible: z.boolean().nullable() }),
  z.object({
    type: z.literal('sidebar'),
    command: z.discriminatedUnion('kind', [
      z.object({ kind: z.enum(['chat', 'search', 'settings']) }),
      z.object({ kind: z.enum(['openNote', 'unpin', 'share']), path: z.string() }),
      z.object({ kind: z.literal('menu'), id: z.string() }),
    ]),
  }),
]) satisfies z.ZodType<ChromeIntent>

/**
 * The intent in a `chrome:intent` payload, or `null` for anything else.
 */
export function parseNativeIntent(payload: unknown): ChromeIntent | null {
  const parsed = intentSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}
