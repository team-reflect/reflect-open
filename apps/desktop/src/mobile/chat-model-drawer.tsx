import { useMemo, type ReactElement } from 'react'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { groupModelOptions } from '@/lib/chat-model-groups'
import { SettingsGroup, SettingsSelectRow } from '@/mobile/settings-list'
import { useChatSession } from '@/providers/chat-provider'

interface ChatModelDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The mobile model picker: desktop's grouped `Select` as a bottom sheet —
 * one inset group per configured provider, checkmark rows per model
 * (the iOS single-choice idiom). Picking persists through the session's
 * `selectModel` (the same `chatModelSelection` settings key) and closes.
 */
export function ChatModelDrawer({ open, onOpenChange }: ChatModelDrawerProps): ReactElement {
  const { providers, modelOptions, activeModel, selectModel } = useChatSession()
  const groups = useMemo(
    () => groupModelOptions(modelOptions, providers),
    [modelOptions, providers],
  )

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Choose a model">
        <DrawerTitle className="px-4 pt-1">Model</DrawerTitle>
        <div className="flex max-h-[60dvh] flex-col gap-6 overflow-y-auto px-4 pb-8 pt-4">
          {groups.map((group) => (
            <SettingsGroup key={group.configId} header={group.label}>
              {group.options.map(({ option, value }) => (
                <SettingsSelectRow
                  key={value}
                  label={option.label}
                  selected={
                    activeModel !== null &&
                    option.configId === activeModel.id &&
                    option.modelId === activeModel.model
                  }
                  onPress={() => {
                    selectModel({ configId: option.configId, modelId: option.modelId })
                    onOpenChange(false)
                  }}
                />
              ))}
            </SettingsGroup>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
