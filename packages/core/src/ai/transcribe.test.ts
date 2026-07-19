import { describe, expect, it } from 'vitest'
import {
  GEMINI_INLINE_MAX_BYTES,
  GOOGLE_TRANSCRIPTION_FALLBACK_MODEL,
  GOOGLE_TRANSCRIPTION_MODEL,
  OPENAI_TRANSCRIPTION_FALLBACK_MODEL,
  OPENAI_TRANSCRIPTION_MODEL,
  bytesToBase64,
  isTranscriptionRejected,
  transcribeAudio,
  type TranscriptionRequest,
} from './transcribe'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: RequestInit['body']
}

function recordingFetch(
  calls: RecordedCall[],
  respond: (call: RecordedCall, index: number) => Response,
): typeof fetch {
  return async (input, init) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

function request(overrides: Partial<TranscriptionRequest>): TranscriptionRequest {
  return {
    provider: 'openai',
    apiKey: 'sk-test',
    audio: new Blob(['abc'], { type: 'audio/mp4' }),
    mimeType: 'audio/mp4',
    ...overrides,
  }
}

describe('transcribeAudio (openai)', () => {
  it('posts multipart with an extension-correct filename and returns the trimmed text', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, () => jsonResponse(200, { text: '  Hello world.  ' }))

    const text = await transcribeAudio(request({ fetchFn }))

    expect(text).toBe('Hello world.')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-test')
    const form = calls[0]!.body as FormData
    expect(form.get('model')).toBe(OPENAI_TRANSCRIPTION_MODEL)
    const file = form.get('file') as File
    // whisper-1 sniffs by extension: an audio-only MP4 must upload as .m4a.
    expect(file.name).toBe('memo.m4a')
  })

  it('names webm recordings .webm', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, () => jsonResponse(200, { text: 'hi' }))

    await transcribeAudio(
      request({ fetchFn, mimeType: 'audio/webm;codecs=opus', audio: new Blob(['abc']) }),
    )

    const file = (calls[0]!.body as FormData).get('file') as File
    expect(file.name).toBe('memo.webm')
  })

  it('falls back to whisper-1 only when the primary model is missing on the key', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, (_call, index) =>
      index === 0
        ? jsonResponse(404, { error: { message: 'no such model', code: 'model_not_found' } })
        : jsonResponse(200, { text: 'fallback worked' }),
    )

    const text = await transcribeAudio(request({ fetchFn }))

    expect(text).toBe('fallback worked')
    expect(calls).toHaveLength(2)
    expect((calls[1]!.body as FormData).get('model')).toBe(OPENAI_TRANSCRIPTION_FALLBACK_MODEL)
  })

  it('rescues a primary-model refusal through whisper-1 — its duration ceiling is higher', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, (call) =>
      (call.body as FormData).get('model') === OPENAI_TRANSCRIPTION_FALLBACK_MODEL
        ? jsonResponse(200, { text: 'long meeting transcript' })
        : jsonResponse(400, { error: { message: 'Audio duration exceeds the limit.', code: null } }),
    )

    const text = await transcribeAudio(request({ fetchFn }))

    expect(text).toBe('long meeting transcript')
    expect(calls).toHaveLength(2)
  })

  it('marks a refused recording as a rejection — retrying the same bytes cannot help', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, () =>
      jsonResponse(400, { error: { message: 'Invalid file format.', code: null } }),
    )

    const failure: unknown = await transcribeAudio(request({ fetchFn })).catch(
      (cause: unknown) => cause,
    )

    expect(isTranscriptionRejected(failure)).toBe(true)
    expect(failure).toMatchObject({ message: expect.stringContaining('Invalid file format.') })
    // The whisper-1 rescue attempt ran (and was refused) before tombstoning.
    expect(calls).toHaveLength(2)
    expect((calls[1]!.body as FormData).get('model')).toBe(OPENAI_TRANSCRIPTION_FALLBACK_MODEL)
  })

  it('never issues a provider call after the stale gate fires', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, () => jsonResponse(200, { text: 'never' }))

    await expect(
      transcribeAudio(request({ fetchFn, isStale: () => true })),
    ).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('graph session') })
    expect(calls).toHaveLength(0)
  })

  it('an oversized payload is a rejection; a rate limit stays a retryable network error', async () => {
    const tooLarge = recordingFetch([], () =>
      jsonResponse(413, { error: { message: 'Maximum content size exceeded.' } }),
    )
    const rejection: unknown = await transcribeAudio(request({ fetchFn: tooLarge })).catch(
      (cause: unknown) => cause,
    )
    expect(isTranscriptionRejected(rejection)).toBe(true)

    const rateLimited = recordingFetch([], () =>
      jsonResponse(429, { error: { message: 'Rate limit reached.' } }),
    )
    const transient: unknown = await transcribeAudio(request({ fetchFn: rateLimited })).catch(
      (cause: unknown) => cause,
    )
    expect(isTranscriptionRejected(transient)).toBe(false)
    expect(transient).toMatchObject({ kind: 'network' })
  })

  it('reports a rejected key as an auth error', async () => {
    const fetchFn = recordingFetch([], () => jsonResponse(401, { error: { message: 'bad key' } }))

    await expect(transcribeAudio(request({ fetchFn }))).rejects.toMatchObject({ kind: 'auth' })
  })

  it('reports an unrecognizable success body as a parse error', async () => {
    const fetchFn = recordingFetch([], () => jsonResponse(200, { transcript: 'wrong shape' }))

    await expect(transcribeAudio(request({ fetchFn }))).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reports a thrown fetch as a network error', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new TypeError('offline')
    }

    await expect(transcribeAudio(request({ fetchFn }))).rejects.toMatchObject({
      kind: 'network',
      message: 'offline',
    })
  })

  it('bounds every request with a timeout signal', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      signals.push(init?.signal)
      return jsonResponse(200, { text: 'ok' })
    }

    await transcribeAudio(request({ fetchFn }))

    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('maps a stalled connection to a settled network error', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }

    await expect(transcribeAudio(request({ fetchFn }))).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('timed out'),
    })
  })
})

describe('transcribeAudio (google)', () => {
  function geminiResponse(text: string): Response {
    return jsonResponse(200, { candidates: [{ content: { parts: [{ text }] } }] })
  }

  it('posts inline base64 audio to the fixed transcription model', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, () => geminiResponse(' transcript here '))

    const text = await transcribeAudio(request({ provider: 'google', apiKey: 'AIza-test', fetchFn }))

    expect(text).toBe('transcript here')
    expect(calls[0]!.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_TRANSCRIPTION_MODEL}:generateContent`,
    )
    expect(calls[0]!.headers['x-goog-api-key']).toBe('AIza-test')
    const payload = JSON.parse(String(calls[0]!.body)) as {
      contents: { parts: { text?: string; inline_data?: { mime_type: string; data: string } }[] }[]
    }
    const parts = payload.contents[0]!.parts
    expect(parts[0]!.text).toContain('Transcribe')
    expect(parts[1]!.inline_data).toEqual({ mime_type: 'audio/mp4', data: btoa('abc') })
  })

  it('strips codec parameters from the declared MIME type', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, () => geminiResponse('ok'))

    await transcribeAudio(
      request({ provider: 'google', fetchFn, mimeType: 'audio/webm;codecs=opus' }),
    )

    const payload = JSON.parse(String(calls[0]!.body)) as {
      contents: { parts: { inline_data?: { mime_type: string } }[] }[]
    }
    expect(payload.contents[0]!.parts[1]!.inline_data?.mime_type).toBe('audio/webm')
  })

  it('falls back to the stable model when the primary one is retired (404)', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, (call) =>
      call.url.includes(GOOGLE_TRANSCRIPTION_FALLBACK_MODEL)
        ? geminiResponse('fallback transcript')
        : jsonResponse(404, { error: { message: 'This model is no longer available.' } }),
    )

    const text = await transcribeAudio(request({ provider: 'google', fetchFn }))

    expect(text).toBe('fallback transcript')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain(GOOGLE_TRANSCRIPTION_MODEL)
    expect(calls[1]!.url).toContain(GOOGLE_TRANSCRIPTION_FALLBACK_MODEL)
  })

  it('does not retry non-404 failures', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, () =>
      jsonResponse(429, { error: { message: 'quota exhausted' } }),
    )

    await expect(transcribeAudio(request({ provider: 'google', fetchFn }))).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('quota exhausted'),
    })
    expect(calls).toHaveLength(1)
  })

  it('marks a refused recording as a rejection', async () => {
    const fetchFn = recordingFetch([], () =>
      jsonResponse(400, { error: { message: 'Invalid audio content.' } }),
    )

    const failure: unknown = await transcribeAudio(
      request({ provider: 'google', fetchFn }),
    ).catch((cause: unknown) => cause)

    expect(isTranscriptionRejected(failure)).toBe(true)
  })

  const UPLOAD_URL = 'https://upload.example/session-1'
  const FILE_RESOURCE = {
    name: 'files/memo-1',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/memo-1',
  }

  function startResponse(): Response {
    return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': UPLOAD_URL } })
  }

  it('routes a recording over the inline budget through the Files API and deletes the file', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, (call, index) => {
      if (index === 0) return startResponse()
      if (call.url === UPLOAD_URL) {
        return call.headers['X-Goog-Upload-Command'] === 'upload, finalize'
          ? jsonResponse(200, { file: { ...FILE_RESOURCE, state: 'PROCESSING' } })
          : new Response('{}', { status: 200 })
      }
      if (call.url.endsWith('/v1beta/files/memo-1') && call.method === 'GET') {
        return jsonResponse(200, { ...FILE_RESOURCE, state: 'ACTIVE' })
      }
      if (call.method === 'DELETE') return new Response('{}', { status: 200 })
      return geminiResponse('meeting transcript')
    })
    const audio = new Blob([new Uint8Array(GEMINI_INLINE_MAX_BYTES + 1)], { type: 'audio/mp4' })

    const text = await transcribeAudio(request({ provider: 'google', fetchFn, audio }))

    expect(text).toBe('meeting transcript')
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'POST', 'GET', 'POST', 'DELETE'])
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/upload/v1beta/files')
    expect(calls[0]!.headers['X-Goog-Upload-Command']).toBe('start')
    expect(calls[0]!.headers['X-Goog-Upload-Header-Content-Length']).toBe(String(audio.size))
    expect(calls[1]!.headers['X-Goog-Upload-Offset']).toBe('0')
    expect(calls[1]!.headers['X-Goog-Upload-Command']).toBe('upload')
    expect(calls[2]!.headers['X-Goog-Upload-Offset']).toBe(String(8 * 1024 * 1024))
    expect(calls[2]!.headers['X-Goog-Upload-Command']).toBe('upload, finalize')
    const generate = JSON.parse(String(calls[4]!.body)) as {
      contents: { parts: { file_data?: { mime_type: string; file_uri: string } }[] }[]
    }
    expect(generate.contents[0]!.parts[1]!.file_data).toEqual({
      mime_type: 'audio/mp4',
      file_uri: FILE_RESOURCE.uri,
    })
    expect(calls[5]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/files/memo-1')
  })

  it('tombstones a recording the Files API cannot process — the same bytes would fail again', async () => {
    const calls: RecordedCall[] = []
    const fetchFn = recordingFetch(calls, (call, index) => {
      if (index === 0) return startResponse()
      if (call.url === UPLOAD_URL) {
        return jsonResponse(200, { file: { ...FILE_RESOURCE, state: 'FAILED' } })
      }
      return new Response('{}', { status: 200 })
    })
    const audio = new Blob([new Uint8Array(GEMINI_INLINE_MAX_BYTES + 1)], { type: 'audio/mp4' })

    const failure: unknown = await transcribeAudio(
      request({ provider: 'google', fetchFn, audio }),
    ).catch((cause: unknown) => cause)

    expect(isTranscriptionRejected(failure)).toBe(true)
    // start + one 8 MiB chunk + finalize — never generateContent on a dead file.
    expect(calls.filter((call) => call.url.includes(':generateContent'))).toHaveLength(0)
  })

  it('returns an empty transcript when no candidates come back', async () => {
    const fetchFn = recordingFetch([], () => jsonResponse(200, {}))

    const text = await transcribeAudio(request({ provider: 'google', fetchFn }))

    expect(text).toBe('')
  })

  it('reports a rejected key as an auth error', async () => {
    const fetchFn = recordingFetch([], () => jsonResponse(403, { error: { message: 'denied' } }))

    await expect(transcribeAudio(request({ provider: 'google', fetchFn }))).rejects.toMatchObject({
      kind: 'auth',
    })
  })
})

describe('bytesToBase64', () => {
  it('matches btoa on small payloads', () => {
    expect(bytesToBase64(new TextEncoder().encode('abc'))).toBe(btoa('abc'))
  })

  it('survives payloads beyond one chunk', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).fill(65)
    expect(bytesToBase64(bytes)).toBe(btoa('A'.repeat(bytes.length)))
  })
})
