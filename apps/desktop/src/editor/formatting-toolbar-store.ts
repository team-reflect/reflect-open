import { useSyncExternalStore } from 'react'

/**
 * Enable/disable state for the toolbar's structural buttons, recomputed from
 * the editor selection (ProseKit `canExec`). Selection-aware enablement is
 * what made V1's native accessory bar feel native — the porting doc calls it
 * the load-bearing behavior, not the buttons themselves.
 */
export interface FormattingToolbarCapabilities {
  canIndent: boolean
  canDedent: boolean
  canMoveUp: boolean
  canMoveDown: boolean
}

/** Autocomplete-trigger characters the toolbar can type into the editor. */
export type FormattingTriggerText = '/' | '[[' | '#'

/**
 * The command surface a focused editor offers the toolbar. Each closes over
 * the live ProseKit editor instance; none require the caller to know the
 * editor's identity or path.
 */
export interface FormattingToolbarCommands {
  toggleBulletList: () => void
  /** Cycle other content → square checklist → round task → square checklist. */
  cycleCheckableList: () => void
  indent: () => void
  dedent: () => void
  moveUp: () => void
  moveDown: () => void
  /** Type an autocomplete trigger at the caret, opening its menu. */
  insertTrigger: (text: FormattingTriggerText) => void
  /** Blur the editor, dropping the software keyboard (and this toolbar). */
  dismissKeyboard: () => void
  /**
   * Scroll the caret back into view if it left the visible area; a no-op
   * while it is visible. Called by the keyboard reveal, not a toolbar button.
   */
  scrollCaretIntoView: () => void
}

/** What the mobile shell's toolbar renders for the focused editor. */
export interface FormattingToolbar {
  capabilities: FormattingToolbarCapabilities
  commands: FormattingToolbarCommands
}

/**
 * Module-scope store for "the focused editor's toolbar", in the same
 * external-store shape as `use-keyboard.ts`. The daily carousel keeps up to
 * three editors mounted at once, so ownership is claimed per bridge instance
 * (an opaque token) on focus and released on blur — a stale release from a
 * blurring editor can never clobber the one that just took focus, because
 * focusout always precedes the next editor's focusin.
 */
let active: FormattingToolbar | null = null
let activeOwner: symbol | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function capabilitiesEqual(
  left: FormattingToolbarCapabilities,
  right: FormattingToolbarCapabilities,
): boolean {
  return (
    left.canIndent === right.canIndent &&
    left.canDedent === right.canDedent &&
    left.canMoveUp === right.canMoveUp &&
    left.canMoveDown === right.canMoveDown
  )
}

/**
 * Claim (or refresh) the active toolbar for `owner`. A refresh with equal
 * capabilities and the same command surface is dropped without notifying, so
 * caret moves that don't change enablement never re-render the toolbar.
 */
export function publishFormattingToolbar(owner: symbol, toolbar: FormattingToolbar): void {
  if (
    activeOwner === owner &&
    active !== null &&
    active.commands === toolbar.commands &&
    capabilitiesEqual(active.capabilities, toolbar.capabilities)
  ) {
    return
  }
  activeOwner = owner
  active = toolbar
  notify()
}

/**
 * Release the active toolbar, but only if `owner` still holds it — a blurred
 * editor unpublishing after another editor already took over is a no-op.
 */
export function clearFormattingToolbar(owner: symbol): void {
  if (activeOwner !== owner) {
    return
  }
  activeOwner = null
  active = null
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): FormattingToolbar | null {
  return active
}

/**
 * The focused editor's toolbar as reactive state — `null` when no editor is
 * focused (e.g. the keyboard was raised by the All-tab search field, where a
 * formatting toolbar would be nine dead buttons).
 */
export function useFormattingToolbar(): FormattingToolbar | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * The focused editor's commands, or `null` when none is focused (always the
 * case off the touch surface). The non-reactive twin of
 * {@link useFormattingToolbar}, for the keyboard caret reveal.
 */
export function focusedEditorCommands(): FormattingToolbarCommands | null {
  return active?.commands ?? null
}
