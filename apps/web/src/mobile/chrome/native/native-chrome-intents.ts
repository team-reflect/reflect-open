import {
  focusedEditorCommands,
  type FormattingToolbarCommands,
} from '@/editor/formatting-toolbar-store.ts'
import type { ToastController } from '@/lib/use-toasts.ts'
import { runChromeAction } from '@/mobile/chrome/chrome-action.ts'
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import type { MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import type { FormattingCommandId, NativeIntent } from '@/mobile/chrome/native/protocol.ts'

/**
 * Inserts files into an editor after the inserts it was given before.
 */
export type AttachFiles = (commands: FormattingToolbarCommands, files: File[]) => void

/**
 * What an intent needs from the page when it runs.
 */
export interface IntentContext {
  entryId: number
  selectTab: (tab: MobileTab) => void
  /**
   * The chrome the screen of `entryId` registered.
   */
  screen: ScreenChrome | undefined
  /**
   * The commands of the last focused editor that can attach files, while
   * the page still shows its entry.
   */
  attachCommands: FormattingToolbarCommands | null
  attachFiles: AttachFiles
  /**
   * Shows the rejection of an action.
   */
  toasts: ToastController
}

const FORMATTING_RUNNERS: Record<
  FormattingCommandId,
  (commands: FormattingToolbarCommands) => void
> = {
  slash: (commands) => commands.insertTrigger('/'),
  list: (commands) => commands.cycleBulletOrderedList(),
  todo: (commands) => commands.cycleCheckableList(),
  link: (commands) => commands.insertTrigger('[['),
  tag: (commands) => commands.insertTrigger('#'),
  dedent: (commands) => commands.dedent(),
  indent: (commands) => commands.indent(),
  up: (commands) => commands.moveUp(),
  down: (commands) => commands.moveDown(),
  dismiss: (commands) => commands.dismissKeyboard(),
}

/**
 * Run a formatting command on the focused editor.
 */
function runFormattingCommand(id: FormattingCommandId): void {
  const commands = focusedEditorCommands()
  if (commands !== null) {
    FORMATTING_RUNNERS[id](commands)
  }
}

function decodeFile(file: { name: string; type: string; data: string }): File {
  const binary = atob(file.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], file.name, { type: file.type })
}

/**
 * Run one intent of the shell. An intent for another history entry than the
 * one on screen is dropped, so a menu left open while the page changed never
 * acts on the new page.
 */
export function runNativeIntent(intent: NativeIntent, context: IntentContext): void {
  switch (intent.type) {
    case 'back':
      if (intent.entryId === context.entryId) {
        context.screen?.back?.()
      }
      return
    case 'tab':
      context.selectTab(intent.tab)
      return
    case 'action':
      if (intent.entryId === context.entryId) {
        void runChromeAction(context.screen, intent.id, context.toasts)
      }
      return
    case 'command':
      runFormattingCommand(intent.id)
      return
    case 'files': {
      const commands = context.attachCommands
      if (commands !== null) {
        context.attachFiles(commands, intent.files.map(decodeFile))
      }
      return
    }
  }
}

/**
 * An {@link AttachFiles} with its own queue. The shell sends one intent per
 * picked image, so each insert waits for the one before it and the images
 * land in the picked order.
 */
export function createAttachQueue(): AttachFiles {
  let queue: Promise<void> = Promise.resolve()
  return (commands, files) => {
    queue = attachAfter(queue, commands, files)
  }
}

async function attachAfter(
  previous: Promise<void>,
  commands: FormattingToolbarCommands,
  files: File[],
): Promise<void> {
  await previous
  try {
    await commands.attachFiles(files)
  } catch (cause) {
    // Reported like an uncaught error; the queue stays settled for the next insert.
    reportError(cause)
  }
}
