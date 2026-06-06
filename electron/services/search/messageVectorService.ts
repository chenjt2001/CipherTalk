/**
 * 消息向量存储与检索（纯 AI SDK：embedMany 建向量 + cosineSimilarity 算 KNN，无原生扩展）。
 *
 * - 文本来源：复用 chatSearchIndexService 已建的 message_index（listSessionMemoryMessages）。
 * - 存储：向量当 Float32 blob 存进独立的 chat_vectors.db（better-sqlite3，cachePath）。
 * - 检索：embedQuery(query) → 取候选会话向量 → cosineSimilarity 排序取 top-K。
 * - 懒构建 + 增量 + 上限：首次对某会话语义检索时嵌入其最近 N 条（之后只补新增）。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { cosineSimilarity } from 'ai'
import { ConfigService } from '../config'
import { chatSearchIndexService } from './chatSearchIndexService'
import { embedTexts, embedQuery, getEmbeddingConfig, type EmbeddingConfig } from '../ai/embeddingService'

const VECTOR_DB_NAME = 'chat_vectors.db'
const DEFAULT_SESSION_CAP = 1500 // 每个会话最多嵌入的（最近）消息条数，控制成本/时延
const EMBED_BATCH = 64
const MAX_EMBED_CHARS = 512

export interface VectorHit {
  sessionId: string
  time: number // create_time（秒）
  isSend: number | null
  senderUsername: string | null
  excerpt: string
  score: number
  anchor: { sessionId: string; localId: number; sortSeq: number; createTime: number }
}

class MessageVectorService {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const cs = new ConfigService()
    try {
      const cachePath = String(cs.get('cachePath') || '').trim()
      return cachePath || join(process.cwd(), 'cache')
    } finally {
      cs.close()
    }
  }

  private getDb(): Database.Database {
    const base = this.getCacheBasePath()
    if (!existsSync(base)) mkdirSync(base, { recursive: true })
    const next = join(base, VECTOR_DB_NAME)
    if (this.db && this.dbPath === next) return this.db
    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
    }
    const db = new Database(next)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_vectors (
        session_id TEXT NOT NULL,
        local_id INTEGER NOT NULL,
        sort_seq INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        is_send INTEGER,
        sender_username TEXT,
        excerpt TEXT,
        dim INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY (session_id, local_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mv_session ON message_vectors(session_id);
    `)
    this.db = db
    this.dbPath = next
    return db
  }

  /** 已启用且配置完整才可用。 */
  isReady(cfg?: EmbeddingConfig): boolean {
    const c = cfg || getEmbeddingConfig()
    return !!(c.enabled && c.apiKey && c.model)
  }

  /**
   * 确保某会话的向量已就绪（懒构建 + 增量）。返回该会话已存向量数。
   */
  async ensureSessionVectors(sessionId: string, cfg: EmbeddingConfig, cap = DEFAULT_SESSION_CAP): Promise<number> {
    const messages = await chatSearchIndexService.listSessionMemoryMessages(sessionId)
    if (messages.length === 0) return 0
    const recent = messages.slice(-cap)
    const db = this.getDb()

    const existing = new Set(
      (db.prepare('SELECT local_id FROM message_vectors WHERE session_id = ?').all(sessionId) as Array<{ local_id: number }>)
        .map((r) => r.local_id)
    )
    const todo = recent.filter((m) => !existing.has(m.localId) && m.parsedContent.trim().length > 0)
    if (todo.length === 0) return existing.size

    const insert = db.prepare(
      `INSERT OR REPLACE INTO message_vectors
       (session_id, local_id, sort_seq, create_time, is_send, sender_username, excerpt, dim, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < todo.length; i += EMBED_BATCH) {
      const chunk = todo.slice(i, i + EMBED_BATCH)
      const vectors = await embedTexts(chunk.map((m) => m.parsedContent.slice(0, MAX_EMBED_CHARS)), cfg)
      const writeBatch = db.transaction(() => {
        chunk.forEach((m, idx) => {
          const vec = vectors[idx]
          if (!vec || vec.length === 0) return
          const buf = Buffer.from(Float32Array.from(vec).buffer)
          insert.run(
            sessionId, m.localId, m.sortSeq, m.createTime, m.isSend ?? null,
            m.senderUsername ?? null, m.parsedContent.replace(/\s+/g, ' ').trim().slice(0, 200),
            vec.length, buf
          )
        })
      })
      writeBatch()
    }
    return existing.size + todo.length
  }

  /** 在某会话已存向量里做 KNN（cosineSimilarity 排序）。 */
  searchSession(sessionId: string, queryVec: number[], limit: number): VectorHit[] {
    const db = this.getDb()
    const rows = db.prepare(
      'SELECT local_id, sort_seq, create_time, is_send, sender_username, excerpt, dim, embedding FROM message_vectors WHERE session_id = ?'
    ).all(sessionId) as Array<{
      local_id: number; sort_seq: number; create_time: number; is_send: number | null
      sender_username: string | null; excerpt: string; dim: number; embedding: Buffer
    }>

    const scored = rows.map((r) => {
      const ab = r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)
      const vec = Array.from(new Float32Array(ab))
      let score = 0
      try {
        score = cosineSimilarity(queryVec, vec)
      } catch {
        score = 0
      }
      return { r, score }
    })
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(({ r, score }) => ({
      sessionId,
      time: r.create_time,
      isSend: r.is_send,
      senderUsername: r.sender_username,
      excerpt: r.excerpt,
      score,
      anchor: { sessionId, localId: r.local_id, sortSeq: r.sort_seq, createTime: r.create_time },
    }))
  }
}

export const messageVectorService = new MessageVectorService()

/** 供查询侧复用：嵌入查询文本。 */
export { embedQuery }
