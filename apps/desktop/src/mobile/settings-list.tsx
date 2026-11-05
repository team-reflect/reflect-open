import type { ReactElement, ReactNode } from 'react'
import { Check, ChevronRight, ChevronsUpDown, type LucideIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner.tsx'
import { cn } from '@/lib/utils.ts'
import { MobileSwitch } from '@/mobile/mobile-switch.tsx'

/**
 * iOS-style inset-grouped list primitives for the mobile settings screens:
 * rounded section cards with hairline row separators, a small muted header
 * above and an explanatory footer below (the platform's Settings idiom).
 * Rows come in the standard shapes — static value, disclosure (chevron),
 * switch, menu choice, action, and checkmark selection.
 */

/**
 * A row of UIKit's inset-grouped list on iOS 27.2: 52px tall, with the text
 * 20px in. The iOS tokens live in `styles/ios.css`.
 */
const ROW_CLASS = 'ios-row-separator relative flex min-h-13 w-full items-center gap-3 px-5 py-3'
const PRESSABLE_ROW_CLASS = cn(
  ROW_CLASS,
  'text-left active:bg-ios-cell-pressed disabled:opacity-40',
)
const CHEVRON_CLASS = '-mr-1 size-[18px] shrink-0 text-ios-tertiary-label'

interface SettingsGroupProps {
  /** Small muted caption above the card (iOS section header). */
  header?: string
  /** Explanatory text below the card (iOS section footer). */
  footer?: ReactNode
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
        <h2 className="px-5 pb-2 text-ios-footnote text-ios-secondary-label">{header}</h2>
      ) : null}
      {/* The font size is set here, not on the rows: `cn` would drop a
          `text-ios-body` row class next to a `text-primary` color class.
          On a grouped-background screen (`data-ios-grouped`) the card is a
          borderless cell; elsewhere (sheets) it keeps a border. */}
      <div className="overflow-hidden rounded-ios-card border border-border bg-surface text-ios-body in-data-ios-grouped:border-0 in-data-ios-grouped:bg-ios-grouped-cell">
        {children}
      </div>
      {footer != null ? (
        <p id={footerId} className="px-5 pt-2 text-ios-footnote text-ios-secondary-label">
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
  onPress,
}: {
  label: string
  value: string
  /** Optional tap handler without pressable styling (the row stays static-looking). */
  onPress?: () => void
}): ReactElement {
  return (
    <div className={ROW_CLASS} onClick={onPress}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-ios-secondary-label tabular-nums">{value}</span>
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
export function SettingsNavRow({
  label,
  value,
  onPress,
  disabled,
}: SettingsNavRowProps): ReactElement {
  return (
    <button type="button" className={PRESSABLE_ROW_CLASS} onClick={onPress} disabled={disabled}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value !== undefined ? (
        <span className="max-w-[55%] shrink-0 truncate text-ios-secondary-label">{value}</span>
      ) : null}
      <ChevronRight aria-hidden className={CHEVRON_CLASS} strokeWidth={2.6} />
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
      <MobileSwitch
        aria-describedby={descriptionId}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </label>
  )
}

export interface SettingsMenuOption<Value extends string> {
  value: Value
  label: string
}

interface SettingsMenuRowProps<Value extends string> {
  label: string
  value: Value
  options: readonly SettingsMenuOption<Value>[]
  onChange: (value: Value) => void
}

/**
 * A row showing the current choice of a small closed set. A transparent
 * native `<select>` covers the row, so a tap opens the platform's menu.
 */
export function SettingsMenuRow<Value extends string>({
  label,
  value,
  options,
  onChange,
}: SettingsMenuRowProps<Value>): ReactElement {
  return (
    <div className={cn(ROW_CLASS, 'relative')}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 text-ios-secondary-label">
        {options.find((option) => option.value === value)?.label}
        <ChevronsUpDown aria-hidden className="-mr-1 size-[15px] shrink-0" strokeWidth={2.4} />
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => {
          const picked = event.currentTarget.value
          const next = options.find((option) => option.value === picked)
          if (next !== undefined) {
            onChange(next.value)
          }
        }}
        className="absolute inset-0 appearance-none text-base opacity-0"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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
        <Icon aria-hidden className="size-5 shrink-0" strokeWidth={2} />
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
        <Check aria-hidden className="-mr-0.5 size-5 shrink-0 text-primary" strokeWidth={2.75} />
      ) : null}
    </button>
  )
}

interface SettingsHeroRowProps {
  title: string
  subtitle?: string | undefined
  /** The large leading tile (an app icon, an avatar, a glyph). */
  media: ReactNode
  onPress: () => void
  disabled?: boolean
}

/**
 * The prominent first row of a settings screen (like the Apple Account row in
 * iOS Settings): a large tile, a semibold title, a muted subtitle, and a
 * chevron. Use it alone in a group without a header.
 */
export function SettingsHeroRow({
  title,
  subtitle,
  media,
  onPress,
  disabled,
}: SettingsHeroRowProps): ReactElement {
  return (
    <button
      type="button"
      className={cn(PRESSABLE_ROW_CLASS, 'gap-4 py-3.5 pl-4')}
      onClick={onPress}
      disabled={disabled}
    >
      <span className="flex size-15 shrink-0 items-center justify-center overflow-hidden rounded-[15px]">
        {media}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-semibold">{title}</span>
        {subtitle !== undefined ? (
          <span className="truncate text-ios-subheadline text-ios-secondary-label">{subtitle}</span>
        ) : null}
      </span>
      <ChevronRight aria-hidden className={CHEVRON_CLASS} strokeWidth={2.6} />
    </button>
  )
}
