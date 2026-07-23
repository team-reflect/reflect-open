import { describe, expect, it } from 'vitest'
import type { AiProvidersState, TranscriptionConfig } from './provider-config'
import {
  GEMINI_FILE_MAX_BYTES,
  OPENAI_TRANSCRIPTION_MAX_BYTES,
  routeTranscription,
} from './transcription-routing'

const OPENAI: TranscriptionConfig = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: 'wxyz1',
}
const GOOGLE: TranscriptionConfig = {
  id: 'cfg-google',
  provider: 'google',
  model: 'gemini-2.5-pro',
  keyHint: 'wxyz2',
}

function state(...providers: TranscriptionConfig[]): AiProvidersState {
  return { providers, defaultProviderId: providers[0]?.id ?? null }
}

describe('routeTranscription', () => {
  it('keeps the preferred provider whenever the recording fits its budget', () => {
    expect(routeTranscription(state(OPENAI, GOOGLE), OPENAI, OPENAI_TRANSCRIPTION_MAX_BYTES)).toBe(
      OPENAI,
    )
  })

  it('falls through to a configured Google entry when OpenAI cannot fit the recording', () => {
    expect(
      routeTranscription(state(OPENAI, GOOGLE), OPENAI, OPENAI_TRANSCRIPTION_MAX_BYTES + 1),
    ).toBe(GOOGLE)
  })

  it('answers null — skip, not tombstone — when no configured provider can fit it', () => {
    expect(routeTranscription(state(OPENAI), OPENAI, OPENAI_TRANSCRIPTION_MAX_BYTES + 1)).toBeNull()
  })

  it('cannot route past even the Files API ceiling', () => {
    expect(routeTranscription(state(GOOGLE), GOOGLE, GEMINI_FILE_MAX_BYTES + 1)).toBeNull()
  })
})
