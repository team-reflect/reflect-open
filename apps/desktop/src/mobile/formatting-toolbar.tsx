import type { ReactElement } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Brackets,
  ChevronDown,
  Hash,
  IndentDecrease,
  IndentIncrease,
  List,
  ListTodo,
  Slash,
} from 'lucide-react'
import { useFormattingToolbar } from '@/editor/formatting-toolbar-store'
import { hapticImpactLight } from '@/mobile/haptics'

/**
 * The webview-drawn formatting toolbar (Plan 19, decision 8 — V1's native
 * accessory bar deliberately not ported). It takes the tab bar's slot at the
 * bottom of the shell root while the keyboard is up, which with the root
 * sized to `calc(100dvh - var(--keyboard-height))` puts it exactly on the
 * keyboard's top edge: no fixed positioning, no safe-area math (the keyboard
 * covers the home-indicator region), and hardware keyboards suppress it for
 * free because the plugin reports their overlap as 0.
 *
 * Item set and order are V1's toolbar spec (the porting doc's requirements
 * list) minus AI prediction and image capture, which have no v2 substrate
 * yet — plus a dismiss button, which V1 never needed because iOS gives a
 * `contenteditable` no Done key. Renders nothing while no editor is focused:
 * the All-tab search field raises the keyboard too, and formatting buttons
 * would be dead weight there.
 *
 * The dismiss button is pinned outside the scrollable region so it stays
 * visible even when the formatting buttons overflow on narrow screens.
 */
export function MobileFormattingToolbar(): ReactElement | null {
  const toolbar = useFormattingToolbar()
  if (toolbar === null) {
    return null
  }
  const { capabilities, commands } = toolbar
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex shrink-0 items-center border-t border-border"
    >
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-1">
        <ToolbarButton
          label="Slash command"
          icon={<Slash className="size-5" />}
          onPress={() => commands.insertTrigger('/')}
        />
        <ToolbarButton
          label="Bullet list"
          icon={<List className="size-5" />}
          onPress={commands.toggleBulletList}
        />
        <ToolbarButton
          label="Cycle checklist and task"
          icon={<ListTodo className="size-5" />}
          onPress={commands.cycleCheckableList}
        />
        <ToolbarButton
          label="Link note"
          icon={<Brackets className="size-5" />}
          onPress={() => commands.insertTrigger('[[')}
        />
        <ToolbarButton
          label="Tag"
          icon={<Hash className="size-5" />}
          onPress={() => commands.insertTrigger('#')}
        />
        <ToolbarButton
          label="Outdent"
          icon={<IndentDecrease className="size-5" />}
          disabled={!capabilities.canDedent}
          onPress={commands.dedent}
        />
        <ToolbarButton
          label="Indent"
          icon={<IndentIncrease className="size-5" />}
          disabled={!capabilities.canIndent}
          onPress={commands.indent}
        />
        <ToolbarButton
          label="Move up"
          icon={<ArrowUp className="size-5" />}
          disabled={!capabilities.canMoveUp}
          onPress={commands.moveUp}
        />
        <ToolbarButton
          label="Move down"
          icon={<ArrowDown className="size-5" />}
          disabled={!capabilities.canMoveDown}
          onPress={commands.moveDown}
        />
      </div>
      <div className="shrink-0 border-l border-border px-1">
        <ToolbarButton
          label="Hide keyboard"
          icon={<ChevronDown className="size-5" />}
          onPress={commands.dismissKeyboard}
        />
      </div>
    </div>
  )
}

function ToolbarButton({
  label,
  icon,
  disabled = false,
  onPress,
}: {
  label: string
  icon: ReactElement
  disabled?: boolean
  onPress: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      // Focus must never leave the editor: cancelling pointerdown (and the
      // compatibility mousedown) stops the tap from moving focus, so the
      // keyboard — and with it this toolbar — can't dismiss mid-tap. The
      // dismiss button drops the keyboard explicitly via `editor.blur()`.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        hapticImpactLight()
        onPress()
      }}
      className="flex h-11 w-10 shrink-0 items-center justify-center rounded-md text-text-muted disabled:opacity-40"
    >
      {icon}
    </button>
  )
}
