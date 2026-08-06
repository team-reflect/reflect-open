import type { ExternalToast } from 'sonner'

export type MockToastOptions = Omit<ExternalToast, 'action'> & {
  action?: { label: string; onClick: () => void }
}
