/**
 * semantic_search —— "找相关内容/某主题"的检索。
 * - 已启用嵌入(embeddingConfig.enabled) 且指定 sessionId → 走向量路径：
 *   embedQuery + cosineSimilarity（AI SDK），按会话懒构建向量、增量、有上限。
 * - 否则（全局 / 未启用嵌入）→ 关键词检索原文（searchChat）兜底。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { searchChat, resolveSenders, toLocalTime } from './shared'

export const semanticSearch = tool({
  description:
    '查找与某主题/某件事相关的聊天记录，适合"聊过类似 X 吗 / 关于某话题都说了啥"。' +
    '每条命中带 anchor，拿到后用 get_context 展开前后原文核对、标注出处。' +
    '配了嵌入模型且带 sessionId 时走语义向量；否则按关键词检索原文。建议带 sessionId 限定范围（先用 list_contacts 拿 username）。' +
    '要精确词用 search_messages；要数量/排名用 chat_stats。',
  inputSchema: z.object({
    query: z.string().describe('自然语言检索意图 / 关键词'),
    sessionId: z.string().optional().describe('限定某会话/群（username，来自 list_contacts）；语义向量仅在带 sessionId 时启用'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳（仅关键词路径生效）'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳（仅关键词路径生效）'),
    limit: z.number().int().min(1).max(50).default(10).describe('返回条数上限'),
  }),
  execute: async ({ query, sessionId, startTimeMs, endTimeMs, limit }) => {
    try {
      const { getEmbeddingConfig } = await import('../../ai/embeddingService')
      const { messageVectorService, embedQuery } = await import('../../search/messageVectorService')
      const cfg = getEmbeddingConfig()

      // 向量路径：需启用嵌入 + 指定会话（懒构建成本只压在单个会话上）
      if (sessionId && messageVectorService.isReady(cfg)) {
        const queryVec = await embedQuery(query, cfg)
        const indexed = await messageVectorService.ensureSessionVectors(sessionId, cfg)
        const vhits = messageVectorService.searchSession(sessionId, queryVec, limit)
        const senderMap = await resolveSenders(vhits.map((h) => h.senderUsername || ''))
        return {
          mode: 'vector',
          indexedVectors: indexed,
          hits: vhits.map((h) => ({
            sessionId: h.sessionId,
            time: toLocalTime(h.time),
            sender: h.isSend === 1 ? '我' : senderMap.get(h.senderUsername || '') || h.senderUsername || '未知',
            excerpt: h.excerpt,
            score: Number(h.score.toFixed(4)),
            anchor: h.anchor,
          })),
        }
      }

      // 关键词回退（全局 / 未配嵌入）
      const { hits, sessionsScanned } = await searchChat({ query, sessionId, startTimeMs, endTimeMs, limit })
      return { mode: 'keyword', sessionsScanned, scope: sessionId ? 'session' : 'recent_sessions', hits }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
