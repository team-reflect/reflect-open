import { useEffect, useRef } from 'react'
import type { AppCommandId, AppCommands } from '@reflect/app'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Command handlers by id. An `undefined` handler registers nothing, so a
 * caller can offer a command only in some states (a note on screen, the chat
 * route).
 */
export type CommandHandlers = {
  readonly [Id in AppCommandId]?: AppCommands[Id] | undefined
}

/**
 * The ids of the defined handlers, as one stable string.
 */
function handlerIdsOf(handlers: CommandHandlers): string {
  return Object.entries(handlers)
    .filter(([, handler]) => handler !== undefined)
    .map(([id]) => id)
    .join(' ')
}

/**
 * A handler for `id` that calls the latest handler that `read` returns.
 */
function forwardTo<Id extends AppCommandId>(id: Id, read: () => CommandHandlers): AppCommands[Id] {
  const forward = (...args: readonly unknown[]): unknown => {
    const handler = read()[id] as ((...args: readonly unknown[]) => unknown) | undefined
    return handler?.(...args)
  }
  return forward as AppCommands[Id]
}

/**
 * Register `handlers` while the calling component is mounted. The latest
 * render's handlers run, so they may close over render values.
 */
export function useCommands(handlers: CommandHandlers): void {
  const { commands } = useAppServices()
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })
  const ids = handlerIdsOf(handlers)
  useEffect(() => {
    if (ids === '') {
      return
    }
    const controller = new AbortController()
    const read = () => handlersRef.current
    for (const id of ids.split(' ') as AppCommandId[]) {
      commands.handle(id, forwardTo(id, read), controller.signal)
    }
    return () => controller.abort()
  }, [commands, ids])
}

/**
 * Stop keys and menu items from running any command except `allow` while
 * `active` is true. A modal screen blocks while it is open.
 */
export function useCommandBlock(active: boolean, allow: readonly AppCommandId[]): void {
  const { commands } = useAppServices()
  useEffect(() => {
    if (!active) {
      return
    }
    const controller = new AbortController()
    commands.block(allow, controller.signal)
    return () => controller.abort()
  }, [commands, active, allow])
}
