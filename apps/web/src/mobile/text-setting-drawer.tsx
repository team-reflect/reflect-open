import { useId, useState, type ReactElement } from 'react'
import { getIsComposing } from '@meowdown/core'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/mobile/scroll-drawer.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'

interface TextSettingDrawerProps {
  title: string
  description: string
  /** Accessible name of the textarea. */
  ariaLabel: string
  placeholder: string
  /** Characters kept on save; longer drafts show a warning and are truncated. */
  maxLength: number
  /** Textarea rows; `1` renders a single-line field where Return saves. */
  rows: number
  /** Canonicalize a draft before it is saved or compared with the default. */
  normalize: (value: string) => string
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (value: string) => void
}

/** The mobile editor for one free-text setting: Save persists, Clear empties. */
export function TextSettingDrawer({
  title,
  open,
  onOpenChange,
  ...sheet
}: TextSettingDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label={title}>
        {open ? (
          <TextSettingSheet title={title} onClose={() => onOpenChange(false)} {...sheet} />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function TextSettingSheet({
  title,
  description,
  ariaLabel,
  placeholder,
  maxLength,
  rows,
  normalize,
  value,
  onSave,
  onClose,
}: Omit<TextSettingDrawerProps, 'open' | 'onOpenChange'> & { onClose: () => void }): ReactElement {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const warningId = useId()
  const currentDraft = dirty ? draft : value
  const overBy = currentDraft.trim().length - maxLength
  const field = {
    'aria-label': ariaLabel,
    'aria-invalid': overBy > 0 || undefined,
    'aria-describedby': overBy > 0 ? warningId : undefined,
    value: currentDraft,
    onChange: (event: { target: { value: string } }) => {
      setDirty(true)
      setDraft(event.target.value)
    },
    autoFocus: true,
    placeholder,
  }

  function save(): void {
    onSave(normalize(currentDraft))
    onClose()
  }

  return (
    <>
      <DrawerTitle>{title}</DrawerTitle>
      <DrawerBody>
        <p className="text-sm text-text-muted">{description}</p>
        {rows === 1 ? (
          <Input
            {...field}
            enterKeyHint="done"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !getIsComposing()) {
                save()
              }
            }}
            className="h-10"
          />
        ) : (
          <Textarea {...field} rows={rows} className="min-h-36 resize-y text-sm" />
        )}
        {overBy > 0 ? (
          <p id={warningId} role="alert" className="text-xs text-destructive">
            {overBy.toLocaleString()} characters over the {maxLength.toLocaleString()}-character
            limit. The extra text is dropped when saved.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={normalize(currentDraft) === ''}
            onClick={() => {
              onSave('')
              onClose()
            }}
          >
            Clear
          </Button>
          <Button type="button" onClick={save}>
            Save
          </Button>
        </div>
      </DrawerBody>
    </>
  )
}
