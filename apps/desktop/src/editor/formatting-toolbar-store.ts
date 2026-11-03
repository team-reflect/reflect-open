import { isDeepEqual } from '@ocavue/utils'
import { WritableStore } from '@reflect/core'
import { useSelector } from '@/lib/use-store.ts'

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
  /**
   * Whether this editor can persist files. Only a pane that was given a
   * `saveFile` can (the inline task editor, for one, was not), and an attach
   * button over an editor without one is a button that does nothing.
   */
  canAttachFiles: boolean
}

/** Autocomplete-trigger characters the toolbar can type into the editor. */
export type FormattingTriggerText = '/' | '[[' | '#'

/**
 * The command surface a focused editor offers the toolbar. Each closes over
 * the live ProseKit editor instance; none require the caller to know the
 * editor's identity or path.
 */
export interface FormattingToolbarCommands {
  /** Cycle other content -> bullet -> ordered -> text */
  cycleBulletOrderedList: () => void
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
   * Persist picked files into the graph's `assets/` and insert their markdown
   * at the caret — `![](…)` for an image, a `[name](…)` link otherwise, the
   * same markdown a paste or drop produces. A no-op without
   * {@link FormattingToolbarCapabilities.canAttachFiles}.
   */
  attachFiles: (files: File[]) => Promise<void>
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
 * The active toolbar and the bridge instance (an opaque token) that owns it.
 */
interface ActiveFormattingToolbar {
  owner: symbol
  toolbar: FormattingToolbar
}

/**
 * Module-scope store for "the focused editor's toolbar". The daily carousel
 * keeps up to three editors mounted at once, so ownership is claimed per
 * bridge instance (an opaque token) on focus and released on blur — a stale
 * release from a blurring editor can never clobber the one that just took
 * focus, because focusout always precedes the next editor's focusin.
 */
const active = new WritableStore<ActiveFormattingToolbar | null>(null, isDeepEqual)

/**
 * Claim (or refresh) the active toolbar for `owner`. A refresh with equal
 * capabilities and the same command surface is dropped without notifying, so
 * caret moves that don't change enablement never re-render the toolbar.
 */
export function publishFormattingToolbar(owner: symbol, toolbar: FormattingToolbar): void {
  active.set({ owner, toolbar })
}

/**
 * Release the active toolbar, but only if `owner` still holds it — a blurred
 * editor unpublishing after another editor already took over is a no-op.
 */
export function clearFormattingToolbar(owner: symbol): void {
  if (active.get()?.owner !== owner) {
    return
  }
  active.set(null)
}

function selectToolbar(value: ActiveFormattingToolbar | null): FormattingToolbar | null {
  return value?.toolbar ?? null
}

/**
 * The focused editor's toolbar as reactive state — `null` when no editor is
 * focused (e.g. the keyboard was raised by the All-tab search field, where a
 * formatting toolbar would be nine dead buttons).
 */
export function useFormattingToolbar(): FormattingToolbar | null {
  return useSelector(active, selectToolbar)
}

/**
 * The focused editor's commands, or `null` when none is focused (always the
 * case off the touch surface). The non-reactive twin of
 * {@link useFormattingToolbar}, for the keyboard caret reveal.
 */
export function focusedEditorCommands(): FormattingToolbarCommands | null {
  return active.get()?.toolbar.commands ?? null
}
