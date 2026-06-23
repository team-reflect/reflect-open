import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { useGraph } from '@/providers/graph-provider'
import { SettingsField } from './field'
import { SettingsSection } from './section'

export function DestructiveSection(): ReactElement {
  const { graph, forget } = useGraph()
  const [forgetting, setForgetting] = useState(false)

  const forgetGraph = async (): Promise<void> => {
    if (graph === null || forgetting) {
      return
    }
    setForgetting(true)
    try {
      await forget(graph.root)
    } finally {
      setForgetting(false)
    }
  }

  return (
    <SettingsSection id="destructive">
      <SettingsField
        legend="Saved graph"
        description="Forget this graph. Files stay on disk."
      >
        <div className="mt-3 flex justify-start">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={graph === null || forgetting}
            onClick={() => void forgetGraph()}
          >
            {forgetting ? 'Forgetting…' : 'Forget graph'}
          </Button>
        </div>
      </SettingsField>
    </SettingsSection>
  )
}
