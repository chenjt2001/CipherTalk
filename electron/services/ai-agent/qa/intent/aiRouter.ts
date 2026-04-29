/**
 * AI 意图预路由：不暴露 tools，只判断是否需要读取本地聊天记录。
 */
import type OpenAI from 'openai'
import type { AIProvider } from '../../../ai/providers/base'
import type { IntentRoute, SessionQAIntentType, ToolLoopAction } from '../types'
import { compactText, stripJsonFence, stripThinkBlocks, isRecord } from '../utils/text'

export type AIIntentRouterDecision = {
  needsLocalEvidence: boolean
  intent: SessionQAIntentType | 'assistant_meta' | 'general_chat' | 'general_knowledge'
  confidence: 'high' | 'medium' | 'low'
  reason?: string
  searchQueries?: string[]
  preferredPlan?: ToolLoopAction['action'][]
}

export type AIIntentRouterResult = {
  route: IntentRoute
  decision?: AIIntentRouterDecision
  promptText: string
  responseText: string
  applied: boolean
}

const TOOL_ACTIONS: Array<ToolLoopAction['action']> = [
  'read_summary_facts',
  'search_messages',
  'read_context',
  'read_latest',
  'read_by_time_range',
  'resolve_participant',
  'aggregate_messages',
  'get_session_statistics',
  'get_keyword_statistics',
  'answer'
]

const ROUTE_INTENTS: SessionQAIntentType[] = [
  'direct_answer',
  'summary_answerable',
  'recent_status',
  'time_range',
  'participant_focus',
  'exact_evidence',
  'media_or_file',
  'broad_summary',
  'stats_or_count',
  'unclear'
]

function uniqueStrings(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of values) {
    const value = compactText(String(item || ''), 48)
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

function uniqueToolActions(values: unknown): ToolLoopAction['action'][] {
  if (!Array.isArray(values)) return []
  const allowed = new Set<string>(TOOL_ACTIONS)
  const seen = new Set<string>()
  const result: ToolLoopAction['action'][] = []
  for (const item of values) {
    const value = String(item || '') as ToolLoopAction['action']
    if (!allowed.has(value) || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function parseConfidence(value: unknown): AIIntentRouterDecision['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium'
}

function parseIntent(value: unknown): AIIntentRouterDecision['intent'] {
  const intent = String(value || '')
  if (ROUTE_INTENTS.includes(intent as SessionQAIntentType)) return intent as SessionQAIntentType
  if (intent === 'assistant_meta' || intent === 'general_chat' || intent === 'general_knowledge') return intent
  return 'unclear'
}

function extractJsonObject(value: string): Record<string, unknown> | null {
  const text = stripJsonFence(stripThinkBlocks(value))
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseAIIntentRouterDecision(responseText: string): AIIntentRouterDecision | null {
  const parsed = extractJsonObject(responseText)
  if (!parsed || typeof parsed.needsLocalEvidence !== 'boolean') return null

  return {
    needsLocalEvidence: parsed.needsLocalEvidence,
    intent: parseIntent(parsed.intent),
    confidence: parseConfidence(parsed.confidence),
    reason: compactText(String(parsed.reason || ''), 160),
    searchQueries: uniqueStrings(parsed.searchQueries, 5),
    preferredPlan: uniqueToolActions(parsed.preferredPlan)
  }
}

export function applyAIIntentDecisionToRoute(route: IntentRoute, decision: AIIntentRouterDecision): IntentRoute {
  if (!decision.needsLocalEvidence && decision.confidence !== 'low') {
    return {
      ...route,
      intent: 'direct_answer',
      confidence: decision.confidence,
      reason: `AI 意图预判：${decision.reason || '不需要读取本地聊天记录'}`,
      participantHints: [],
      searchQueries: [],
      needsSearch: false,
      preferredPlan: ['answer']
    }
  }

  if (!decision.needsLocalEvidence) {
    return route
  }

  const routeIntent = ROUTE_INTENTS.includes(decision.intent as SessionQAIntentType)
    && decision.intent !== 'direct_answer'
    ? decision.intent as SessionQAIntentType
    : route.intent
  const searchQueries = Array.from(new Set([
    ...route.searchQueries,
    ...(decision.searchQueries || [])
  ].map((item) => item.trim()).filter(Boolean)))
  const preferredPlan = decision.preferredPlan?.length ? decision.preferredPlan : route.preferredPlan

  return {
    ...route,
    intent: routeIntent,
    confidence: decision.confidence,
    reason: `AI 意图预判：${decision.reason || '需要读取本地聊天记录'}`,
    searchQueries,
    needsSearch: route.needsSearch || routeIntent === 'exact_evidence' || routeIntent === 'media_or_file' || routeIntent === 'stats_or_count',
    preferredPlan
  }
}

export function buildAIIntentRouterPrompt(input: {
  question: string
  sessionName?: string
  historyText: string
  heuristicRoute: IntentRoute
  model: string
  providerName: string
}): string {
  return `只判断用户问题是否需要读取当前会话的本地聊天记录。不要回答用户问题，不要调用工具，只输出严格 JSON。

当前助手：
- 产品：CipherTalk 问答助手
- 服务商：${input.providerName}
- 当前模型：${input.model || '未知'}

当前会话：${input.sessionName || '未知会话'}

用户问题：
${input.question}

最近多轮上下文：
${input.historyText || '无'}

本地启发式线索：
- intent: ${input.heuristicRoute.intent}
- needsSearch: ${input.heuristicRoute.needsSearch ? 'true' : 'false'}
- searchQueries: ${input.heuristicRoute.searchQueries.join('、') || '无'}
- preferredPlan: ${input.heuristicRoute.preferredPlan.join(' -> ') || '无'}

判定规则：
- needsLocalEvidence=false：用户问助手身份、当前模型、服务商、功能、用法、寒暄、感谢、一般闲聊；这些不需要读取聊天记录。
- needsLocalEvidence=true：用户问当前会话/聊天记录/消息/群成员/某人说过什么/是否提到某词/聊天总结/时间段内容/统计/图片文件语音链接等，需要本地聊天证据。
- 如果问题没有明确指向“当前会话、聊天记录、消息、群、某人说过、提到过、统计、最近/昨天聊什么”，优先判为 false。
- “你是什么模型”“你是谁”“介绍一下你自己”“你能做什么”必须判为 false。

输出 JSON schema：
{
  "needsLocalEvidence": boolean,
  "intent": "assistant_meta|general_chat|general_knowledge|summary_answerable|recent_status|time_range|participant_focus|exact_evidence|media_or_file|broad_summary|stats_or_count|unclear",
  "confidence": "high|medium|low",
  "reason": "一句话原因",
  "searchQueries": [],
  "preferredPlan": []
}`
}

export async function refineRouteWithAIIntent(input: {
  provider: AIProvider
  model: string
  question: string
  sessionName?: string
  historyText: string
  heuristicRoute: IntentRoute
}): Promise<AIIntentRouterResult> {
  const promptText = buildAIIntentRouterPrompt({
    question: input.question,
    sessionName: input.sessionName,
    historyText: input.historyText,
    heuristicRoute: input.heuristicRoute,
    model: input.model,
    providerName: input.provider.displayName || input.provider.name
  })
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: '你是严格的意图路由分类器。只输出 JSON，不要 Markdown，不要解释。' },
    { role: 'user', content: promptText }
  ]
  const responseText = await input.provider.chat(messages, {
    model: input.model,
    temperature: 0,
    maxTokens: 320,
    enableThinking: false
  })
  const decision = parseAIIntentRouterDecision(responseText)
  if (!decision) {
    return {
      route: input.heuristicRoute,
      promptText,
      responseText,
      applied: false
    }
  }

  return {
    route: applyAIIntentDecisionToRoute(input.heuristicRoute, decision),
    decision,
    promptText,
    responseText,
    applied: true
  }
}
