import type { MaybePromise } from '@reflect/utils'
import type { LanguageModel } from '@reflect/modules/ai'
import { MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type {
  AiKeyValidationService,
  ApiKeyValidation,
  ApiKeyValidationInput,
} from '../ai/ai-key-validation-service.ts'
import type { LanguageModelService } from '../ai/language-model-service.ts'
import type { AssetDescriberService, DescribeAssetRequest } from '../ai/asset-describer-service.ts'
import type {
  DescribePageRequest,
  PageDescriberService,
  PageEnrichment,
} from '../ai/page-describer-service.ts'
import {
  createTranscriptionService,
  type TranscriptionRequest,
  type TranscriptionService,
} from '../ai/transcription-service.ts'
import type { AiProviderConfig } from '../settings/schema.ts'

/**
 * A model, or a function that answers each `create` call.
 */
export type TestLanguageModelSource =
  | LanguageModel
  | ((config: AiProviderConfig, apiKey: string) => MaybePromise<LanguageModel>)

/**
 * A `create` call the fake received.
 */
export interface TestLanguageModelCall {
  config: AiProviderConfig
  apiKey: string
}

export interface TestLanguageModelService extends LanguageModelService {
  /**
   * Every `create` call, in order.
   */
  calls(): readonly TestLanguageModelCall[]
  /**
   * Replaces the model that later `create` calls answer with.
   */
  setModel(model: TestLanguageModelSource): void
}

class TestLanguageModelServiceImpl implements TestLanguageModelService {
  #source: TestLanguageModelSource
  readonly #log: TestLanguageModelCall[] = []

  constructor(source: TestLanguageModelSource) {
    this.#source = source
  }

  async create(config: AiProviderConfig, apiKey: string): Promise<LanguageModel> {
    this.#log.push({ config, apiKey })
    const source = this.#source
    return typeof source === 'function' ? await source(config, apiKey) : source
  }

  calls(): readonly TestLanguageModelCall[] {
    return [...this.#log]
  }

  setModel(model: TestLanguageModelSource): void {
    this.#source = model
  }
}

/**
 * A {@link LanguageModelService} that answers every `create` call with
 * `model`, an empty `MockLanguageModelV3` by default. No provider SDK loads
 * and no request leaves the process.
 */
export function createTestLanguageModelService(
  model: TestLanguageModelSource = new MockLanguageModelV3(),
): TestLanguageModelService {
  return new TestLanguageModelServiceImpl(model)
}

export interface TestAiKeyValidationService extends AiKeyValidationService {
  /**
   * Every input passed to `validate()`, in order.
   */
  calls(): readonly ApiKeyValidationInput[]
  /**
   * Replaces the result that later `validate()` calls answer with.
   */
  setResult(result: ApiKeyValidation): void
}

class TestAiKeyValidationServiceImpl implements TestAiKeyValidationService {
  #current: ApiKeyValidation
  readonly #log: ApiKeyValidationInput[] = []

  constructor(result: ApiKeyValidation) {
    this.#current = result
  }

  async validate(input: ApiKeyValidationInput): Promise<ApiKeyValidation> {
    this.#log.push(input)
    return this.#current
  }

  calls(): readonly ApiKeyValidationInput[] {
    return [...this.#log]
  }

  setResult(result: ApiKeyValidation): void {
    this.#current = result
  }
}

/**
 * An {@link AiKeyValidationService} that answers `result` without any request.
 */
export function createTestAiKeyValidationService(
  result: ApiKeyValidation = 'valid',
): TestAiKeyValidationService {
  return new TestAiKeyValidationServiceImpl(result)
}

/**
 * A page enrichment, or a function that answers each `describe` call.
 */
export type TestPageDescriberSource =
  | PageEnrichment
  | ((request: DescribePageRequest) => MaybePromise<PageEnrichment>)

export interface TestPageDescriberService extends PageDescriberService {
  /**
   * Every request passed to `describe()`, in order.
   */
  calls(): readonly DescribePageRequest[]
  /**
   * Replaces the result that later `describe()` calls answer with.
   */
  setResult(result: TestPageDescriberSource): void
}

class TestPageDescriberServiceImpl implements TestPageDescriberService {
  #source: TestPageDescriberSource
  readonly #log: DescribePageRequest[] = []

  constructor(result: TestPageDescriberSource) {
    this.#source = result
  }

  async describe(request: DescribePageRequest): Promise<PageEnrichment> {
    this.#log.push(request)
    const source = this.#source
    return typeof source === 'function' ? await source(request) : source
  }

  calls(): readonly DescribePageRequest[] {
    return [...this.#log]
  }

  setResult(result: TestPageDescriberSource): void {
    this.#source = result
  }
}

/**
 * A {@link PageDescriberService} that answers `result` without any provider
 * call: no title and an empty description by default.
 */
export function createTestPageDescriberService(
  result: TestPageDescriberSource = { title: null, description: '' },
): TestPageDescriberService {
  return new TestPageDescriberServiceImpl(result)
}

/**
 * A description, or a function that answers each `describe` call.
 */
export type TestAssetDescriberSource =
  | string
  | ((request: DescribeAssetRequest) => MaybePromise<string>)

export interface TestAssetDescriberService extends AssetDescriberService {
  /**
   * Every request passed to `describe()`, in order.
   */
  calls(): readonly DescribeAssetRequest[]
  /**
   * Replaces the result that later `describe()` calls answer with.
   */
  setResult(result: TestAssetDescriberSource): void
}

class TestAssetDescriberServiceImpl implements TestAssetDescriberService {
  #source: TestAssetDescriberSource
  readonly #log: DescribeAssetRequest[] = []

  constructor(result: TestAssetDescriberSource) {
    this.#source = result
  }

  async describe(request: DescribeAssetRequest): Promise<string> {
    this.#log.push(request)
    const source = this.#source
    return typeof source === 'function' ? await source(request) : source
  }

  calls(): readonly DescribeAssetRequest[] {
    return [...this.#log]
  }

  setResult(result: TestAssetDescriberSource): void {
    this.#source = result
  }
}

/**
 * An {@link AssetDescriberService} that answers `result` without any provider
 * call: an empty description by default.
 */
export function createTestAssetDescriberService(
  result: TestAssetDescriberSource = '',
): TestAssetDescriberService {
  return new TestAssetDescriberServiceImpl(result)
}

/**
 * A transcript, or a function that answers each `transcribe` call.
 */
export type TestTranscriptionSource =
  | string
  | ((request: TranscriptionRequest) => MaybePromise<string>)

export interface TestTranscriptionService extends TranscriptionService {
  /**
   * Every request passed to `transcribe()`, in order.
   */
  calls(): readonly TranscriptionRequest[]
  /**
   * Replaces the result that later `transcribe()` calls answer with.
   */
  setResult(result: TestTranscriptionSource): void
}

class TestTranscriptionServiceImpl implements TestTranscriptionService {
  #source: TestTranscriptionSource
  readonly #log: TranscriptionRequest[] = []
  readonly #real: TranscriptionService

  constructor(result: TestTranscriptionSource) {
    this.#source = result
    this.#real = createTranscriptionService({
      http: {
        fetch: () => Promise.reject(new Error('The test transcription service has no network')),
      },
    })
  }

  async transcribe(request: TranscriptionRequest): Promise<string> {
    this.#log.push(request)
    const source = this.#source
    return typeof source === 'function' ? await source(request) : source
  }

  sessionTranscript(apiKey: string): string | null {
    return this.#real.sessionTranscript(apiKey)
  }

  calls(): readonly TranscriptionRequest[] {
    return [...this.#log]
  }

  setResult(result: TestTranscriptionSource): void {
    this.#source = result
  }
}

/**
 * A {@link TranscriptionService} that answers `result` without any request:
 * an empty transcript by default. `sessionTranscript` is the real one, so the
 * App Review demo key gets its canned transcript.
 */
export function createTestTranscriptionService(
  result: TestTranscriptionSource = '',
): TestTranscriptionService {
  return new TestTranscriptionServiceImpl(result)
}
