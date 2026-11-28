import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { EmbedStatus } from '@reflect/core'
import {
  createTestCoreServices,
  createTestDatabaseService,
  createTestEmbeddingRuntimeService,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { SearchSection } from './search-section.tsx'

async function renderSection(status: EmbedStatus) {
  const core = createTestCoreServices({
    database: createTestDatabaseService(),
    embeddingRuntime: createTestEmbeddingRuntimeService({ status }),
  })
  await renderInApp(<SearchSection />, { core, settings: { semanticSearchEnabled: true } })
}

describe('SearchSection', () => {
  it('shows the model behind the info button', async () => {
    await renderSection({ status: 'ready', model: 'embeddinggemma-test' })

    await expect.element(page.getByText('Ready')).toBeVisible()
    await expect.element(page.getByText('Model: embeddinggemma-test')).not.toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: 'About semantic search' }))
    await expect.element(page.getByText('Model: embeddinggemma-test')).toBeVisible()
  })

  it('shows the model download as a progress bar', async () => {
    await renderSection({
      status: 'loading',
      progress: { downloaded: 100_000_000, total: 400_000_000 },
    })

    await expect.element(page.getByText('Downloading 25%')).toBeVisible()
    await expect
      .element(page.getByRole('progressbar', { name: 'Semantic search progress' }))
      .toHaveAttribute('aria-valuenow', '25')
  })
})
