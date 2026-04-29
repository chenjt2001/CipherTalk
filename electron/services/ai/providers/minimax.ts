import OpenAI from 'openai'
import { BaseAIProvider, ChatOptions } from './base'

/**
 * MiniMax 提供商元数据
 *
 * 2026-04-23 对齐官方 OpenAI 兼容文档：
 * - baseURL: https://api.minimaxi.com/v1
 * - reasoning_split=true 时，思考内容单独出现在 reasoning_details 字段
 */
export const MiniMaxMetadata = {
  id: 'minimax',
  name: 'minimax',
  displayName: 'MiniMax',
  description: 'MiniMax OpenAI 兼容文本模型',
  models: [
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2'
  ],
  pricing: '¥0.0021/1K tokens 起（估算）',
  pricingDetail: {
    input: 0.0021,
    output: 0.0084
  },
  website: 'https://platform.minimaxi.com/',
  logo: './AI-logo/minimax.svg'
}

const THINK_OPEN_TAG = '<think>'
const THINK_CLOSE_TAG = '</think>'

function extractIncrementalText(current: string, previous: string): string {
  if (!current) return ''
  if (!previous) return current
  return current.startsWith(previous) ? current.slice(previous.length) : current
}

/**
 * MiniMax 在 OpenAI 兼容接口中支持通过 reasoning_split=true
 * 将思考内容拆到 reasoning_details 字段中。
 */
export class MiniMaxProvider extends BaseAIProvider {
  name = MiniMaxMetadata.name
  displayName = MiniMaxMetadata.displayName
  models = MiniMaxMetadata.models
  pricing = MiniMaxMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.minimaxi.com/v1')
  }

  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const client = await this.getClient()
    const enableThinking = options?.enableThinking !== false

    const requestParams: any = {
      model: options?.model || this.models[0],
      messages,
      temperature: options?.temperature || 0.7,
      stream: true,
      extra_body: {
        reasoning_split: true
      }
    }

    if (options?.maxTokens) {
      requestParams.max_tokens = options.maxTokens
    }

    const stream = await client.chat.completions.create(requestParams) as any

    let reasoningBuffer = ''
    let textBuffer = ''
    let isThinking = false

    const emitThinkOpen = () => {
      if (!enableThinking || isThinking) return
      onChunk(THINK_OPEN_TAG)
      isThinking = true
    }

    const emitThinkClose = () => {
      if (!isThinking) return
      if (enableThinking) {
        onChunk(THINK_CLOSE_TAG)
      }
      isThinking = false
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      const reasoningDetails = Array.isArray(delta.reasoning_details)
        ? delta.reasoning_details
        : []

      if (reasoningDetails.length > 0) {
        for (const detail of reasoningDetails) {
          const reasoningText = typeof detail?.text === 'string' ? detail.text : ''
          const newReasoning = extractIncrementalText(reasoningText, reasoningBuffer)
          reasoningBuffer = reasoningText || reasoningBuffer

          if (!newReasoning) continue

          emitThinkOpen()
          if (enableThinking) {
            onChunk(newReasoning)
          }
        }
      } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const newReasoning = extractIncrementalText(delta.reasoning_content, reasoningBuffer)
        reasoningBuffer = delta.reasoning_content

        if (newReasoning) {
          emitThinkOpen()
          if (enableThinking) {
            onChunk(newReasoning)
          }
        }
      }

      // reasoning_split=true 时 content 是纯文本，不会混入 <think> 标签
      if (typeof delta.content === 'string' && delta.content) {
        const newContent = extractIncrementalText(delta.content, textBuffer)
        textBuffer = delta.content

        if (newContent) {
          if (isThinking) {
            emitThinkClose()
          }
          onChunk(newContent)
        }
      }
    }

    emitThinkClose()
  }
}
