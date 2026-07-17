import type { ReactElement, ReactNode } from 'react'
import { Check, ChevronRight, type LucideIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * iOS-style inset-grouped list primitives for the mobile settings screens:
 * rounded section cards with hairline row separators, a small muted header
 * above and an explanatory footer below (the platform's Settings idiom).
 * Rows come in the standard shapes — static value, disclosure (chevron),
 * switch, inline segmented choice, action, and checkmark selection.
 */

const ROW_CLASS = 'flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-[15px]'
const PRESSABLE_ROW_CLASS = cn(
  ROW_CLASS,
  'text-left transition-colors active:bg-secondary/70 disabled:opacity-50',
)

interface SettingsGroupProps {
  /** Small muted caption above the card (iOS section header). */
  header?: string
  /** Explanatory text below the card (iOS section footer). */
  footer?: string | null
  /** Optional id for associating the footer with a control in the group. */
  footerId?: string
  children: ReactNode
}

/** One inset-grouped section: header caption, rounded card, footer text. */
export function SettingsGroup({
  header,
  footer,
  footerId,
  children,
}: SettingsGroupProps): ReactElement {
  return (
    <section className="flex flex-col">
      {header !== undefined ? (
        <h2 className="px-4 pb-1.5 text-[13px] font-medium text-text-muted">{header}</h2>
      ) : null}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {children}
      </div>
      {footer != null ? (
        <p id={footerId} className="px-4 pt-1.5 text-[13px] text-text-muted">
          {footer}
        </p>
      ) : null}
    </section>
  )
}

/** A static label / value pair (version, note count, …). */
export function SettingsValueRow({
  label,
  value,
}: {
  label: string
  value: string
}): ReactElement {
  return (
    <div className={ROW_CLASS}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-text-muted tabular-nums">{value}</span>
    </div>
  )
}

interface SettingsNavRowProps {
  label: string
  /** Muted current value shown before the chevron. */
  value?: string | undefined
  onPress: () => void
  disabled?: boolean
}

/** A disclosure row: tapping navigates deeper (trailing chevron). */
export function SettingsNavRow({ label, value, onPress, disabled }: SettingsNavRowProps): ReactElement {
  return (
    <button type="button" className={PRESSABLE_ROW_CLASS} onClick={onPress} disabled={disabled}>
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {value !== undefined ? <span className="shrink-0 text-text-muted">{value}</span> : null}
      <ChevronRight aria-hidden className="size-4 shrink-0 text-text-muted" strokeWidth={1.75} />
    </button>
  )
}

interface SettingsSwitchRowProps {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Id of explanatory copy announced after the switch label. */
  descriptionId?: string
}

/** A toggle row. The whole row is the label, so tapping anywhere flips it. */
export function SettingsSwitchRow({
  label,
  checked,
  onCheckedChange,
  descriptionId,
}: SettingsSwitchRowProps): ReactElement {
  return (
    <label className={ROW_CLASS}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Switch
        aria-describedby={descriptionId}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </label>
  )
}

export interface SegmentedOption<Value extends string> {
  value: Value
  label: string
}

interface SettingsSegmentedRowProps<Value extends string> {
  label: string
  value: Value
  options: readonly SegmentedOption<Value>[]
  onChange: (value: Value) => void
}

/** A row with an inline segmented control for a small closed choice. */
export function SettingsSegmentedRow<Value extends string>({
  label,
  value,
  options,
  onChange,
}: SettingsSegmentedRowProps<Value>): ReactElement {
  return (
    <div className={cn(ROW_CLASS, 'justify-between')}>
      <span className="min-w-0 truncate">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-lg bg-secondary p-0.5">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
                selected ? 'bg-background shadow-sm' : 'text-text-muted',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface SettingsActionRowProps {
  label: string
  onPress: () => void
  /** `destructive` renders the label in the destructive color (iOS red row). */
  tone?: 'default' | 'destructive'
  icon?: LucideIcon
  disabled?: boolean
  /** Replaces the icon with a spinner and disables the row. */
  pending?: boolean
}

/** A tappable action row (disconnect, create, …). */
export function SettingsActionRow({
  label,
  onPress,
  tone = 'default',
  icon: Icon,
  disabled,
  pending,
}: SettingsActionRowProps): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        PRESSABLE_ROW_CLASS,
        tone === 'destructive' ? 'text-destructive' : 'text-primary',
      )}
      onClick={onPress}
      disabled={disabled === true || pending === true}
    >
      {pending === true ? (
        <Spinner />
      ) : Icon !== undefined ? (
        <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

interface SettingsSelectRowProps {
  label: string
  /** Trailing checkmark — the row is the current choice. */
  selected: boolean
  onPress: () => void
  /** A switch to this row is in flight — show a spinner in the check slot. */
  pending?: boolean
  disabled?: boolean
}

/** A checkmark-selection row (the iOS single-choice list idiom). */
export function SettingsSelectRow({
  label,
  selected,
  onPress,
  pending,
  disabled,
}: SettingsSelectRowProps): ReactElement {
  return (
    <button
      type="button"
      className={PRESSABLE_ROW_CLASS}
      onClick={onPress}
      disabled={disabled}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {pending === true ? (
        <Spinner />
      ) : selected ? (
        <Check aria-hidden className="size-4 shrink-0 text-primary" strokeWidth={2} />
      ) : null}
    </button>
  )
}
