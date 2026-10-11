import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { UpstreamProtocol } from '@aihub/shared';

import type {
  ChannelRecord,
  LogFilters,
  LogRecordInput,
} from './types.js';

interface SettingsRecord {
  gatewayToken: string;
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

interface ChannelRow {
  id: string;
  name: string;
  protocol: UpstreamProtocol;
  base_url: string;
  api_key: string;
  default_max_tokens: number;
  enabled: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface DatabaseHandle {
  raw: DatabaseSync;
  close(): void;
}

function migrateChannelsProtocolCheck(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'responses'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE channels_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'responses', 'anthropic')),
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        default_max_tokens INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO channels_new(
        id, name, protocol, base_url, api_key, default_max_tokens, enabled, created_at, updated_at
      )
      SELECT id, name, protocol, base_url, api_key, default_max_tokens, enabled, created_at, updated_at
      FROM channels
    `);
    db.exec('DROP TABLE channels');
    db.exec('ALTER TABLE channels_new RENAME TO channels');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateChannelsAddPosition(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(channels)').all() as unknown as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'position')) return;
  db.exec('ALTER TABLE channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  const rows = db.prepare('SELECT id FROM channels ORDER BY created_at ASC, id ASC').all() as unknown as Array<{
    id: string;
  }>;
  const update = db.prepare('UPDATE channels SET position = ? WHERE id = ?');
  rows.forEach((row, index) => update.run(index, row.id));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function maskSecret(secret: string): string {
  if (!secret) return '';
  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

function rowToChannel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    defaultMaxTokens: row.default_max_tokens,
    enabled: Boolean(row.enabled),
    models: [],
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDatabase(databasePath: string): DatabaseHandle {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);
  migrateChannelsProtocolCheck(db);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'responses', 'anthropic')),
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      default_max_tokens INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      virtual_model TEXT NOT NULL,
      channel_id TEXT,
      channel_name TEXT,
      protocol TEXT,
      upstream_model TEXT,
      stream INTEGER NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      duration_ms INTEGER NOT NULL,
      error_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(virtual_model);
    CREATE INDEX IF NOT EXISTS idx_request_logs_channel ON request_logs(channel_id);
    CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status);
  `);
  migrateChannelsAddPosition(db);
  db.exec(`
    DROP TABLE IF EXISTS model_channels;
    DROP TABLE IF EXISTS virtual_models;

    CREATE TABLE IF NOT EXISTS channel_models (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_channel_models_model ON channel_models(model_id);
  `);

  const defaults: Array<[string, string]> = [
    ['gatewayToken', randomToken()],
    ['connectTimeoutMs', '10000'],
    ['streamIdleTimeoutMs', '60000'],
  ];
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [key, value] of defaults) {
    insertSetting.run(key, value);
  }

  return {
    raw: db,
    close() {
      db.close();
    },
  };
}

export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  getSettings(): SettingsRecord {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((row) => [row.key, row.value]));
    return {
      gatewayToken: map.get('gatewayToken') ?? '',
      connectTimeoutMs: Number.parseInt(map.get('connectTimeoutMs') ?? '10000', 10),
      streamIdleTimeoutMs: Number.parseInt(map.get('streamIdleTimeoutMs') ?? '60000', 10),
    };
  }

  updateSettings(input: Partial<SettingsRecord>): void {
    const statement = this.db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      statement.run(key, String(value));
    }
  }

  private modelsForChannel(channelId: string): string[] {
    const rows = this.db
      .prepare('SELECT model_id FROM channel_models WHERE channel_id = ? ORDER BY model_id ASC')
      .all(channelId) as unknown as Array<{ model_id: string }>;
    return rows.map((row) => row.model_id);
  }

  private attachModels(channels: ChannelRecord[]): ChannelRecord[] {
    if (channels.length === 0) return [];
    const rows = this.db
      .prepare('SELECT channel_id, model_id FROM channel_models ORDER BY channel_id ASC, model_id ASC')
      .all() as unknown as Array<{ channel_id: string; model_id: string }>;
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.channel_id) ?? [];
      list.push(row.model_id);
      map.set(row.channel_id, list);
    }
    return channels.map((channel) => ({ ...channel, models: map.get(channel.id) ?? [] }));
  }

  private replaceChannelModels(channelId: string, models: string[], createdAt: number): void {
    const existing = new Map(
      (
        this.db.prepare('SELECT model_id, created_at FROM channel_models WHERE channel_id = ?').all(channelId) as unknown as Array<{
          model_id: string;
          created_at: number;
        }>
      ).map((row) => [row.model_id, row.created_at]),
    );
    this.db.prepare('DELETE FROM channel_models WHERE channel_id = ?').run(channelId);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO channel_models(channel_id, model_id, created_at) VALUES (?, ?, ?)',
    );
    const seen = new Set<string>();
    for (const raw of models) {
      const model = raw.trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      insert.run(channelId, model, existing.get(model) ?? createdAt);
    }
  }

  listChannels(): ChannelRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM channels ORDER BY position ASC, created_at ASC, id ASC')
      .all() as unknown as ChannelRow[];
    return this.attachModels(rows.map(rowToChannel));
  }

  getChannel(id: string): ChannelRecord | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as unknown as ChannelRow | undefined;
    if (!row) return null;
    return { ...rowToChannel(row), models: this.modelsForChannel(id) };
  }

  listChannelsByModel(modelId: string): ChannelRecord[] {
    const rows = this.db
      .prepare(`
        SELECT c.* FROM channels c
        JOIN channel_models cm ON cm.channel_id = c.id
        WHERE cm.model_id = ?
        ORDER BY c.position ASC, c.created_at ASC, c.id ASC
      `)
      .all(modelId) as unknown as ChannelRow[];
    return this.attachModels(rows.map(rowToChannel));
  }

  listPublicModels(): Array<{ id: string; createdAt: number }> {
    return this.db
      .prepare(`
        SELECT model_id AS id, MIN(created_at) AS createdAt
        FROM channel_models
        GROUP BY model_id
        ORDER BY model_id ASC
      `)
      .all() as unknown as Array<{ id: string; createdAt: number }>;
  }

  createChannel(input: {
    name: string;
    protocol: ChannelRecord['protocol'];
    baseUrl: string;
    apiKey: string;
    defaultMaxTokens: number;
    enabled: boolean;
    models?: string[];
  }): ChannelRecord {
    const ts = nowSeconds();
    const id = crypto.randomUUID();
    const next = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM channels').get() as {
      position: number;
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO channels(id, name, protocol, base_url, api_key, default_max_tokens, enabled, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.name,
        input.protocol,
        input.baseUrl,
        input.apiKey,
        input.defaultMaxTokens,
        input.enabled ? 1 : 0,
        next.position,
        ts,
        ts,
      );
      this.replaceChannelModels(id, input.models ?? [], ts);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getChannel(id)!;
  }

  duplicateChannel(id: string): ChannelRecord | null {
    const source = this.getChannel(id);
    if (!source) return null;
    return this.createChannel({
      name: `${source.name}-copy`,
      protocol: source.protocol,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      defaultMaxTokens: source.defaultMaxTokens,
      enabled: source.enabled,
      models: source.models,
    });
  }

  updateChannel(
    id: string,
    input: Partial<Omit<ChannelRecord, 'id' | 'createdAt' | 'updatedAt' | 'position'>>,
  ): ChannelRecord | null {
    const current = this.getChannel(id);
    if (!current) return null;
    const next = { ...current, ...input, updatedAt: nowSeconds() };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        UPDATE channels
        SET name = ?, protocol = ?, base_url = ?, api_key = ?, default_max_tokens = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.name,
        next.protocol,
        next.baseUrl,
        next.apiKey,
        next.defaultMaxTokens,
        next.enabled ? 1 : 0,
        next.updatedAt,
        id,
      );
      if (input.models !== undefined) this.replaceChannelModels(id, input.models, next.updatedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getChannel(id);
  }

  reorderChannels(ids: string[]): boolean {
    const rows = this.db.prepare('SELECT id FROM channels').all() as unknown as Array<{ id: string }>;
    const requested = new Set(ids);
    if (ids.length !== rows.length || requested.size !== ids.length || !rows.every((row) => requested.has(row.id))) {
      return false;
    }
    this.db.exec('BEGIN');
    try {
      const update = this.db.prepare('UPDATE channels SET position = ? WHERE id = ?');
      ids.forEach((id, index) => update.run(index, id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  deleteChannel(id: string): boolean {
    const result = this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    return result.changes > 0;
  }

  insertLog(input: LogRecordInput): void {
    this.db.prepare(`
      INSERT INTO request_logs(
        created_at, virtual_model, channel_id, channel_name, protocol, upstream_model,
        stream, status, http_status, duration_ms, error_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.createdAt,
      input.virtualModel,
      input.channelId,
      input.channelName,
      input.protocol,
      input.upstreamModel,
      input.stream ? 1 : 0,
      input.status,
      input.httpStatus,
      input.durationMs,
      input.errorSummary,
    );
  }

  listLogs(filters: LogFilters): unknown[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.model) {
      where.push('virtual_model = ?');
      params.push(filters.model);
    }
    if (filters.channelId) {
      where.push('channel_id = ?');
      params.push(filters.channelId);
    }
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.stream !== undefined) {
      where.push('stream = ?');
      params.push(filters.stream ? 1 : 0);
    }
    if (filters.from !== undefined) {
      where.push('created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to !== undefined) {
      where.push('created_at <= ?');
      params.push(filters.to);
    }
    const sql = `
      SELECT
        id, created_at AS createdAt, virtual_model AS virtualModel, channel_id AS channelId,
        channel_name AS channelName, protocol, upstream_model AS upstreamModel, stream,
        status, http_status AS httpStatus, duration_ms AS durationMs, error_summary AS errorSummary
      FROM request_logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `;
    params.push(filters.limit, filters.offset);
    const rows = this.db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      stream: Boolean(row.stream),
    }));
  }
}

export { maskSecret };
