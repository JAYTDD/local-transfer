import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, Repository } from '../src/db.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('database migrations', () => {
  it('upgrades channels and drops the legacy model tables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-db-'));
    tempDirs.push(dir);
    const databasePath = path.join(dir, 'aihub.sqlite');
    const oldDb = new DatabaseSync(databasePath);
    oldDb.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        default_max_tokens INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO channels(
        id, name, protocol, base_url, api_key, default_max_tokens, enabled, created_at, updated_at
      ) VALUES ('existing', 'Existing', 'openai', 'https://old.test/v1', 'sk-old', 100, 1, 1, 1);

      CREATE TABLE virtual_models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE model_channels (
        model_id TEXT NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        upstream_model TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (model_id, channel_id),
        UNIQUE (model_id, position)
      );
      INSERT INTO virtual_models(id, name, created_at, updated_at) VALUES ('vm1', 'virtual', 1, 1);
      INSERT INTO model_channels(model_id, channel_id, upstream_model, position)
        VALUES ('vm1', 'existing', 'upstream-model', 0);
    `);
    oldDb.close();

    const database = createDatabase(databasePath);
    const repository = new Repository(database.raw);

    const tables = (
      database.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).not.toContain('virtual_models');
    expect(tables).not.toContain('model_channels');
    expect(tables).toContain('channel_models');

    const channels = repository.listChannels();
    expect(channels.map((channel) => channel.name)).toEqual(['Existing']);
    expect(channels[0]!.position).toBe(0);
    expect(channels[0]!.models).toEqual([]);

    const created = repository.createChannel({
      name: 'Responses',
      protocol: 'responses',
      baseUrl: 'https://new.test/v1',
      apiKey: 'sk-new',
      defaultMaxTokens: 200,
      enabled: true,
      models: ['gpt-5'],
    });
    expect(created.protocol).toBe('responses');
    expect(created.position).toBe(1);
    expect(created.models).toEqual(['gpt-5']);
    database.close();
  });
});
