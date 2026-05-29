import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { getUserDataPath } from '../runtimePaths'
import type { ConversationDetail, ConversationSummary, MessageRecord, Scope } from './types'
import { resolveScope } from './scope'

type Row = Record<string, any>

class ConversationStore {
  private db: Database.Database | null = null

  init(cachePath?: string): void {
    const basePath = cachePath || getUserDataPath()
    const dbPath = join(basePath, 'aiagent_conversations.db')
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma('foreign_keys = ON')
    this.createTables()
    this.runMigrations(basePath)
  }

  isInitialized(): boolean {
    return this.db !== null
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('[AIAgentConversationStore] 数据库未初始化')
    return this.db
  }

  private createTables(): void {
    this.getDb().exec(`
      CREATE TABLE IF NOT EXISTS aiagent_conversations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_kind  TEXT NOT NULL DEFAULT 'global',
        session_id  TEXT,
        title       TEXT NOT NULL DEFAULT '新对话',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aiagent_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES aiagent_conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        blocks_json     TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aiagent_migrations (
        name       TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_aiagent_msg_conv ON aiagent_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_aiagent_conv_scope ON aiagent_conversations(scope_kind, session_id, updated_at DESC);
    `)
  }

  listConversations(scope: Scope, limit = 50): ConversationSummary[] {
    const db = this.getDb()
    const normalizedScope = resolveScope(scope)
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit || 50)))
    const rows = normalizedScope.kind === 'global'
      ? db.prepare(`
          SELECT
            c.id,
            c.title,
            c.updated_at,
            (
              SELECT m.content FROM aiagent_messages m
              WHERE m.conversation_id = c.id
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT 1
            ) AS last_content
          FROM aiagent_conversations c
          WHERE c.scope_kind = 'global' AND c.session_id IS NULL
          ORDER BY c.updated_at DESC, c.id DESC
          LIMIT ?
        `).all(normalizedLimit) as Row[]
      : db.prepare(`
          SELECT
            c.id,
            c.title,
            c.updated_at,
            (
              SELECT m.content FROM aiagent_messages m
              WHERE m.conversation_id = c.id
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT 1
            ) AS last_content
          FROM aiagent_conversations c
          WHERE c.scope_kind = 'session' AND c.session_id = ?
          ORDER BY c.updated_at DESC, c.id DESC
          LIMIT ?
        `).all(normalizedScope.sessionId, normalizedLimit) as Row[]

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      preview: row.last_content ? String(row.last_content).slice(0, 60) : '',
      updatedAt: row.updated_at
    }))
  }

  loadConversation(id: number): ConversationDetail | null {
    const summary = this.getConversationSummary(id)
    if (!summary) return null

    const rows = this.getDb().prepare(`
      SELECT id, conversation_id, role, content, blocks_json, created_at
      FROM aiagent_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(id) as Row[]

    return {
      ...summary,
      messages: rows.map(row => this.mapMessage(row))
    }
  }

  createConversation(scope: Scope, title = '新对话'): number {
    const normalizedScope = resolveScope(scope)
    const now = Date.now()
    const result = this.getDb().prepare(`
      INSERT INTO aiagent_conversations (scope_kind, session_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      normalizedScope.kind,
      normalizedScope.kind === 'session' ? normalizedScope.sessionId : null,
      title || '新对话',
      now,
      now
    )
    return result.lastInsertRowid as number
  }

  appendMessage(conversationId: number, role: string, content: string, blocksJson?: string | null, createdAt = Date.now()): number {
    const db = this.getDb()
    const result = db.prepare(`
      INSERT INTO aiagent_messages (conversation_id, role, content, blocks_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, role, content || '', blocksJson ?? null, createdAt)

    db.prepare('UPDATE aiagent_conversations SET updated_at = ? WHERE id = ?')
      .run(createdAt, conversationId)

    return result.lastInsertRowid as number
  }

  updateTitle(id: number, title: string): void {
    this.getDb().prepare('UPDATE aiagent_conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title || '新对话', Date.now(), id)
  }

  deleteConversation(id: number): void {
    this.getDb().prepare('DELETE FROM aiagent_conversations WHERE id = ?').run(id)
  }

  getLastConversationId(scope: Scope): number | null {
    const [latest] = this.listConversations(scope, 1)
    return latest?.id ?? null
  }

  hasConversation(id: number): boolean {
    const row = this.getDb()
      .prepare('SELECT 1 AS ok FROM aiagent_conversations WHERE id = ? LIMIT 1')
      .get(id) as { ok?: number } | undefined
    return Boolean(row?.ok)
  }

  private getConversationSummary(id: number): ConversationSummary | null {
    const row = this.getDb().prepare(`
      SELECT
        c.id,
        c.title,
        c.updated_at,
        (
          SELECT m.content FROM aiagent_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS last_content
      FROM aiagent_conversations c
      WHERE c.id = ?
    `).get(id) as Row | undefined

    return row
      ? {
          id: row.id,
          title: row.title,
          preview: row.last_content ? String(row.last_content).slice(0, 60) : '',
          updatedAt: row.updated_at
        }
      : null
  }

  private mapMessage(row: Row): MessageRecord {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      blocksJson: row.blocks_json,
      createdAt: row.created_at
    }
  }

  private runMigrations(basePath: string): void {
    this.migrateAgentConversations(basePath)
    this.migrateSessionQAConversations(basePath)
  }

  private hasMigration(name: string): boolean {
    const row = this.getDb()
      .prepare('SELECT 1 AS ok FROM aiagent_migrations WHERE name = ? LIMIT 1')
      .get(name) as { ok?: number } | undefined
    return Boolean(row?.ok)
  }

  private markMigration(name: string): void {
    this.getDb().prepare('INSERT OR REPLACE INTO aiagent_migrations (name, applied_at) VALUES (?, ?)')
      .run(name, Date.now())
  }

  private tableExists(db: Database.Database, tableName: string): boolean {
    const row = db.prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(tableName) as { ok?: number } | undefined
    return Boolean(row?.ok)
  }

  private migrateAgentConversations(basePath: string): void {
    const migrationName = 'legacy-agent-conversations-v1'
    const legacyPath = join(basePath, 'agent_conversations.db')
    if (this.hasMigration(migrationName) || !existsSync(legacyPath)) return

    const legacyDb = new Database(legacyPath, { readonly: true, fileMustExist: true })
    try {
      if (!this.tableExists(legacyDb, 'agent_conversations') || !this.tableExists(legacyDb, 'agent_messages')) {
        this.markMigration(migrationName)
        return
      }

      const conversations = legacyDb.prepare(`
        SELECT id, title, created_at, updated_at
        FROM agent_conversations
        ORDER BY id ASC
      `).all() as Row[]
      const messagesByConversation = legacyDb.prepare(`
        SELECT id, conversation_id, role, content, blocks_json, created_at
        FROM agent_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `)

      const insertConversation = this.getDb().prepare(`
        INSERT INTO aiagent_conversations (scope_kind, session_id, title, created_at, updated_at)
        VALUES ('global', NULL, ?, ?, ?)
      `)
      const insertMessage = this.getDb().prepare(`
        INSERT INTO aiagent_messages (conversation_id, role, content, blocks_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)

      const migrate = this.getDb().transaction(() => {
        for (const conversation of conversations) {
          const result = insertConversation.run(
            conversation.title || '新对话',
            conversation.created_at || Date.now(),
            conversation.updated_at || conversation.created_at || Date.now()
          )
          const nextConversationId = result.lastInsertRowid as number
          const messages = messagesByConversation.all(conversation.id) as Row[]
          for (const message of messages) {
            insertMessage.run(
              nextConversationId,
              message.role,
              message.content || '',
              message.blocks_json ?? null,
              message.created_at || Date.now()
            )
          }
        }
        this.markMigration(migrationName)
      })
      migrate()
    } finally {
      legacyDb.close()
    }
  }

  private migrateSessionQAConversations(basePath: string): void {
    const migrationName = 'legacy-session-qa-conversations-v1'
    const legacyPath = join(basePath, 'ai_summary.db')
    if (this.hasMigration(migrationName) || !existsSync(legacyPath)) return

    const legacyDb = new Database(legacyPath, { readonly: true, fileMustExist: true })
    try {
      if (!this.tableExists(legacyDb, 'qa_conversations') || !this.tableExists(legacyDb, 'qa_messages')) {
        this.markMigration(migrationName)
        return
      }

      const conversations = legacyDb.prepare(`
        SELECT id, session_id, title, created_at, updated_at, last_message_at
        FROM qa_conversations
        WHERE deleted_at IS NULL
        ORDER BY id ASC
      `).all() as Row[]
      const messagesByConversation = legacyDb.prepare(`
        SELECT id, conversation_id, role, content, error, created_at
        FROM qa_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `)

      const insertConversation = this.getDb().prepare(`
        INSERT INTO aiagent_conversations (scope_kind, session_id, title, created_at, updated_at)
        VALUES ('session', ?, ?, ?, ?)
      `)
      const insertMessage = this.getDb().prepare(`
        INSERT INTO aiagent_messages (conversation_id, role, content, blocks_json, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `)

      const migrate = this.getDb().transaction(() => {
        for (const conversation of conversations) {
          const result = insertConversation.run(
            conversation.session_id,
            conversation.title || '新对话',
            conversation.created_at || Date.now(),
            conversation.updated_at || conversation.last_message_at || conversation.created_at || Date.now()
          )
          const nextConversationId = result.lastInsertRowid as number
          const messages = messagesByConversation.all(conversation.id) as Row[]
          for (const message of messages) {
            insertMessage.run(
              nextConversationId,
              message.role,
              message.content || message.error || '',
              message.created_at || Date.now()
            )
          }
        }
        this.markMigration(migrationName)
      })
      migrate()
    } finally {
      legacyDb.close()
    }
  }
}

export const conversationStore = new ConversationStore()
