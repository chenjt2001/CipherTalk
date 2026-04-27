import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { cpus } from 'os'
import { dirname, join } from 'path'
import { ConfigService } from '../config'

export type RerankerModelProfileId = 'qwen3-reranker-0.6b-onnx-q8'
export type RerankerDevice = 'cpu'

export type RerankerModelProfile = {
  id: RerankerModelProfileId
  displayName: string
  description: string
  modelId: string
  remoteHosts: string[]
  remotePathTemplate: string
  revision: string
  dtype: 'q8'
  maxTokens: number
  maxTextChars: number
  sizeLabel: string
  instruction: string
  enabled: boolean
}

export type RerankerModelStatus = {
  profileId: string
  displayName: string
  modelId: string
  dtype: string
  sizeLabel: string
  enabled: boolean
  exists: boolean
  modelDir: string
  sizeBytes: number
}

export type RerankerDownloadProgress = {
  profileId: string
  displayName: string
  remoteHost?: string
  file?: string
  loaded?: number
  total?: number
  percent?: number
  status?: string
}

export type RerankDocument = {
  id: string
  text: string
  originalScore?: number
  metadata?: Record<string, unknown>
}

export type RerankResult = RerankDocument & {
  rerankScore: number
  combinedScore: number
  rank: number
}

const HUGGINGFACE_HOST = 'https://huggingface.co/'
const HUGGINGFACE_PATH_TEMPLATE = '{model}/resolve/{revision}/'
const DEFAULT_RERANKER_MODEL_PROFILE: RerankerModelProfileId = 'qwen3-reranker-0.6b-onnx-q8'
const CPU_RERANKER_THREADS = Math.max(1, Math.min(2, Math.floor((cpus().length || 2) / 2)))
const DEFAULT_RERANK_LIMIT = 120
const RERANK_BATCH_SIZE = 4

const RERANKER_MODEL_PROFILES: RerankerModelProfile[] = [
  {
    id: 'qwen3-reranker-0.6b-onnx-q8',
    displayName: 'Qwen3 Reranker 0.6B · 新一代',
    description: '本地候选精排模型，用于 FTS/ANN 召回后的相关性重排。',
    modelId: 'huggingworld/Qwen3-Reranker-0.6B-ONNX',
    remoteHosts: [HUGGINGFACE_HOST],
    remotePathTemplate: HUGGINGFACE_PATH_TEMPLATE,
    revision: 'main',
    dtype: 'q8',
    maxTokens: 8192,
    maxTextChars: 3200,
    sizeLabel: '约 600 MB',
    instruction: 'Given a chat history search query, judge whether the document is relevant to the query',
    enabled: true
  }
]

function safeProfileId(value: unknown): RerankerModelProfileId {
  const id = String(value || '').trim() as RerankerModelProfileId
  const profile = RERANKER_MODEL_PROFILES.find((item) => item.id === id && item.enabled)
  return profile?.id || DEFAULT_RERANKER_MODEL_PROFILE
}

function directorySize(dir: string): number {
  if (!existsSync(dir)) return 0

  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += directorySize(path)
    } else if (entry.isFile()) {
      total += statSync(path).size
    }
  }
  return total
}

function hasModelFiles(dir: string): boolean {
  if (!existsSync(dir)) return false

  let hasOnnx = false
  let hasTokenizer = false
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }

      if (entry.name.endsWith('.onnx')) hasOnnx = true
      if (entry.name === 'tokenizer.json' || entry.name === 'tokenizer_config.json') hasTokenizer = true
    }
  }

  visit(dir)
  return hasOnnx && hasTokenizer
}

function getElectronAppSafe(): any | null {
  try {
    const electronModule = require('electron')
    const electronApp = electronModule && typeof electronModule === 'object' ? electronModule.app : null
    return electronApp?.getPath ? electronApp : null
  } catch {
    return null
  }
}

function getEffectiveCachePathFromConfig(): string {
  const configService = new ConfigService()
  try {
    const configured = String(configService.get('cachePath' as any) || '').trim()
    if (configured) return configured
  } finally {
    configService.close()
  }

  const electronApp = getElectronAppSafe()
  if (electronApp?.getPath) {
    const documentsPath = electronApp.getPath('documents')
    if (process.env.VITE_DEV_SERVER_URL) {
      return join(documentsPath, 'CipherTalkData')
    }

    const installDir = dirname(electronApp.getPath('exe'))
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\\\')
    return isOnCDrive ? join(documentsPath, 'CipherTalkData') : join(installDir, 'CipherTalkData')
  }

  return join(process.cwd(), 'CipherTalkData')
}

function compactText(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function buildRerankerPrompt(query: string, document: string, instruction: string): string {
  return `<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${document}`
}

function softmaxPair(falseLogit: number, trueLogit: number): number {
  const max = Math.max(falseLogit, trueLogit)
  const falseExp = Math.exp(falseLogit - max)
  const trueExp = Math.exp(trueLogit - max)
  const sum = falseExp + trueExp
  return sum > 0 ? trueExp / sum : 0
}

function getTokenId(tokenizer: any, token: string): number {
  const converted = tokenizer.convert_tokens_to_ids?.(token)
  if (Number.isInteger(converted) && converted >= 0) return converted

  const encoded = tokenizer.encode?.(token, { add_special_tokens: false })
  const id = Array.isArray(encoded) ? Number(encoded[0]) : Number.NaN
  if (Number.isInteger(id) && id >= 0) return id

  throw new Error(`Reranker token id not found: ${token}`)
}

function getLogitAt(data: ArrayLike<number>, dims: number[], batch: number, token: number, vocabId: number): number {
  if (dims.length === 3) {
    const [, seqLength, vocabSize] = dims
    return Number(data[(batch * seqLength + token) * vocabSize + vocabId] || 0)
  }

  if (dims.length === 2) {
    const [, vocabSize] = dims
    return Number(data[batch * vocabSize + vocabId] || 0)
  }

  throw new Error(`Reranker logits shape invalid: ${dims.join('x')}`)
}

function getLastTokenIndex(attentionMask: any, batch: number, seqLength: number): number {
  const maskData = attentionMask?.data
  if (!maskData) return seqLength - 1

  for (let index = seqLength - 1; index >= 0; index -= 1) {
    if (Number(maskData[batch * seqLength + index] || 0) > 0) {
      return index
    }
  }
  return seqLength - 1
}

export class LocalRerankerService {
  private pipelines = new Map<string, Promise<{ tokenizer: any; model: any; tokenFalseId: number; tokenTrueId: number }>>()
  private downloadTasks = new Map<string, Promise<RerankerModelStatus>>()

  listProfiles(): RerankerModelProfile[] {
    return RERANKER_MODEL_PROFILES.map((profile) => ({ ...profile }))
  }

  getProfile(profileId?: string): RerankerModelProfile {
    const id = safeProfileId(profileId || this.getCurrentProfileId())
    return RERANKER_MODEL_PROFILES.find((profile) => profile.id === id)!
  }

  getCurrentProfileId(): RerankerModelProfileId {
    const configService = new ConfigService()
    try {
      return safeProfileId(configService.get('aiRerankerModelProfile' as any))
    } finally {
      configService.close()
    }
  }

  setCurrentProfileId(profileId: string): RerankerModelProfileId {
    const id = safeProfileId(profileId)
    const configService = new ConfigService()
    try {
      configService.set('aiRerankerModelProfile' as any, id)
      return id
    } finally {
      configService.close()
    }
  }

  isEnabled(): boolean {
    const configService = new ConfigService()
    try {
      return configService.get('aiRerankEnabled' as any) !== false
    } finally {
      configService.close()
    }
  }

  setEnabled(enabled: boolean): boolean {
    const configService = new ConfigService()
    try {
      configService.set('aiRerankEnabled' as any, Boolean(enabled))
      return Boolean(enabled)
    } finally {
      configService.close()
    }
  }

  getModelsRoot(): string {
    return join(getEffectiveCachePathFromConfig(), 'models', 'rerankers')
  }

  getProfileDir(profileId?: string): string {
    return join(this.getModelsRoot(), this.getProfile(profileId).id)
  }

  async getModelStatus(profileId?: string): Promise<RerankerModelStatus> {
    const profile = this.getProfile(profileId)
    const modelDir = this.getProfileDir(profile.id)
    const exists = hasModelFiles(modelDir)
    return {
      profileId: profile.id,
      displayName: profile.displayName,
      modelId: profile.modelId,
      dtype: profile.dtype,
      sizeLabel: profile.sizeLabel,
      enabled: profile.enabled,
      exists,
      modelDir,
      sizeBytes: directorySize(modelDir)
    }
  }

  async downloadModel(
    profileId?: string,
    onProgress?: (progress: RerankerDownloadProgress) => void
  ): Promise<RerankerModelStatus> {
    const profile = this.getProfile(profileId)
    const existing = this.downloadTasks.get(profile.id)
    if (existing) return existing

    const task = (async () => {
      mkdirSync(this.getProfileDir(profile.id), { recursive: true })
      await this.downloadPipelineWithFallback(profile, onProgress)
      return this.getModelStatus(profile.id)
    })()

    this.downloadTasks.set(profile.id, task)
    try {
      return await task
    } finally {
      this.downloadTasks.delete(profile.id)
    }
  }

  async clearModel(profileId?: string): Promise<RerankerModelStatus> {
    const profile = this.getProfile(profileId)
    this.clearPipelines(profile.id)
    rmSync(this.getProfileDir(profile.id), { recursive: true, force: true })
    return this.getModelStatus(profile.id)
  }

  async ensureModelReady(profileId?: string): Promise<RerankerModelStatus> {
    const status = await this.getModelStatus(profileId)
    if (!status.exists) {
      throw new Error(`本地精排模型未下载：${status.displayName}`)
    }
    return status
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: { profileId?: string; limit?: number } = {}
  ): Promise<RerankResult[]> {
    const profile = this.getProfile(options.profileId)
    const limitedDocs = documents
      .filter((document) => String(document.text || '').trim())
      .slice(0, Math.max(1, Math.min(options.limit || DEFAULT_RERANK_LIMIT, DEFAULT_RERANK_LIMIT)))

    if (!String(query || '').trim() || limitedDocs.length === 0) {
      return []
    }

    await this.ensureModelReady(profile.id)
    const runtime = await this.getPipeline(profile, true)
    const scores: number[] = []

    for (let offset = 0; offset < limitedDocs.length; offset += RERANK_BATCH_SIZE) {
      const batch = limitedDocs.slice(offset, offset + RERANK_BATCH_SIZE)
      const prompts = batch.map((document) => buildRerankerPrompt(
        compactText(query, profile.maxTextChars),
        compactText(document.text, profile.maxTextChars),
        profile.instruction
      ))
      scores.push(...await this.scorePrompts(runtime, profile, prompts))
    }

    return limitedDocs
      .map((document, index) => {
        const rerankScore = Number((scores[index] || 0).toFixed(6))
        const originalScore = Number.isFinite(document.originalScore) ? Number(document.originalScore) : 0
        const combinedScore = Number((rerankScore * 1000 + Math.max(0, Math.min(originalScore, 2000)) / 2000).toFixed(6))
        return {
          ...document,
          rerankScore,
          combinedScore,
          rank: index + 1
        }
      })
      .sort((a, b) => b.rerankScore - a.rerankScore || b.combinedScore - a.combinedScore)
      .map((document, index) => ({ ...document, rank: index + 1 }))
  }

  private async scorePrompts(
    runtime: { tokenizer: any; model: any; tokenFalseId: number; tokenTrueId: number },
    profile: RerankerModelProfile,
    prompts: string[]
  ): Promise<number[]> {
    const prefix = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
    const suffix = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
    runtime.tokenizer.padding_side = 'left'
    const modelInputs = runtime.tokenizer(prompts.map((prompt) => `${prefix}${prompt}${suffix}`), {
      padding: true,
      truncation: true,
      max_length: profile.maxTokens
    })
    const output = await runtime.model(modelInputs)
    const logits = output?.logits
    const data = logits?.data
    const dims = Array.isArray(logits?.dims) ? logits.dims.map((item: unknown) => Number(item)) : []
    if (!data || (dims.length !== 2 && dims.length !== 3)) {
      throw new Error('Reranker 模型输出为空')
    }

    const batchSize = dims[0]
    const seqLength = dims.length === 3 ? dims[1] : 1
    const scores: number[] = []
    for (let batch = 0; batch < batchSize; batch += 1) {
      const tokenIndex = dims.length === 3 ? getLastTokenIndex(modelInputs.attention_mask, batch, seqLength) : 0
      const falseLogit = getLogitAt(data, dims, batch, tokenIndex, runtime.tokenFalseId)
      const trueLogit = getLogitAt(data, dims, batch, tokenIndex, runtime.tokenTrueId)
      scores.push(softmaxPair(falseLogit, trueLogit))
    }
    return scores
  }

  private async getPipeline(
    profile: RerankerModelProfile,
    localOnly: boolean,
    remoteHost?: string,
    progressCallback?: (event: any) => void
  ): Promise<{ tokenizer: any; model: any; tokenFalseId: number; tokenTrueId: number }> {
    const key = `${profile.id}:${localOnly ? 'local' : remoteHost || 'remote'}`
    const existing = this.pipelines.get(key)
    if (existing) return existing

    const promise = (async () => {
      const transformers = await import('@huggingface/transformers')
      transformers.env.allowLocalModels = true
      transformers.env.allowRemoteModels = !localOnly
      transformers.env.cacheDir = this.getProfileDir(profile.id)
      const wasm = (transformers.env.backends?.onnx as any)?.wasm
      if (wasm && typeof wasm === 'object') {
        wasm.numThreads = CPU_RERANKER_THREADS
      }
      if (remoteHost) {
        transformers.env.remoteHost = remoteHost
        transformers.env.remotePathTemplate = profile.remotePathTemplate
      }

      const commonOptions = {
        cache_dir: this.getProfileDir(profile.id),
        local_files_only: localOnly,
        revision: profile.revision,
        progress_callback: progressCallback
      }
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(profile.modelId, commonOptions as any)
      const model = await transformers.AutoModelForCausalLM.from_pretrained(profile.modelId, {
        ...commonOptions,
        dtype: profile.dtype,
        session_options: {
          executionMode: 'sequential',
          interOpNumThreads: 1,
          intraOpNumThreads: CPU_RERANKER_THREADS
        }
      } as any)
      return {
        tokenizer,
        model,
        tokenFalseId: getTokenId(tokenizer, 'no'),
        tokenTrueId: getTokenId(tokenizer, 'yes')
      }
    })()

    this.pipelines.set(key, promise)
    try {
      return await promise
    } catch (error) {
      this.pipelines.delete(key)
      throw error
    }
  }

  private clearPipelines(profileId?: string): void {
    for (const key of Array.from(this.pipelines.keys())) {
      if (!profileId || key.startsWith(`${profileId}:`)) {
        this.pipelines.delete(key)
      }
    }
  }

  private async downloadPipelineWithFallback(
    profile: RerankerModelProfile,
    onProgress?: (progress: RerankerDownloadProgress) => void
  ): Promise<void> {
    const errors: string[] = []

    for (const remoteHost of profile.remoteHosts) {
      try {
        onProgress?.({
          profileId: profile.id,
          displayName: profile.displayName,
          remoteHost,
          status: 'initiate'
        })

        await this.getPipeline(profile, false, remoteHost, (event) => {
          const loaded = Number(event?.loaded || 0)
          const total = Number(event?.total || 0)
          onProgress?.({
            profileId: profile.id,
            displayName: profile.displayName,
            remoteHost,
            file: String(event?.file || event?.name || ''),
            loaded: Number.isFinite(loaded) && loaded > 0 ? loaded : undefined,
            total: Number.isFinite(total) && total > 0 ? total : undefined,
            percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined,
            status: String(event?.status || '')
          })
        })
        return
      } catch (error) {
        errors.push(`${remoteHost}: ${String(error)}`)
      }
    }

    throw new Error(`精排模型下载失败。已尝试模型源：${profile.remoteHosts.join('、')}。请检查网络/代理或稍后重试。${errors.length ? ` 原始错误：${errors.join(' | ')}` : ''}`)
  }
}

export const localRerankerService = new LocalRerankerService()
