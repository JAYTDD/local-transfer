import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, Repository } from '../src/db.js';
import { applyUsageCatalog, creditCost, mapRelayLog } from '../src/relay.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('relay request logs', () => {
  it('maps a successful relay entry to a request_logs record', () => {
    expect(
      mapRelayLog({
        at: 1_700_000_000_000,
        channel: 'trae',
        channelLabel: 'Trae 国内版',
        model: 'trae/deepseek-v4.1-flash',
        upstreamModel: 'deepseek-v4.1-flash',
        stream: true,
        status: 'ok',
        durationMs: 1234,
      }),
    ).toEqual({
      createdAt: 1_700_000_000,
      virtualModel: 'trae/deepseek-v4.1-flash',
      channelId: 'relay:trae',
      channelName: 'Trae 国内版',
      protocol: 'relay',
      upstreamModel: 'deepseek-v4.1-flash',
      stream: true,
      status: 'ok',
      httpStatus: null,
      durationMs: 1234,
      errorSummary: null,
      modelName: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedTokens: null,
      creditRate: null,
    });
  });

  it('keeps token counts and the credit rate when the upstream reported them', () => {
    expect(
      mapRelayLog({
        channel: 'wb',
        model: 'wb/hy3',
        modelName: 'GLM',
        status: 'ok',
        promptTokens: 12,
        completionTokens: 3.9,
        totalTokens: 16,
        cachedTokens: 4,
        creditRate: 'x0.79',
      }),
    ).toMatchObject({
      virtualModel: 'wb/hy3',
      modelName: 'GLM',
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 16,
      cachedTokens: 4,
      creditRate: 'x0.79',
    });
  });

  it('computes credits as tokens times the catalog rate per thousand', () => {
    expect(creditCost({
      promptTokens: 2000,
      completionTokens: 500,
      creditRate: 'x0.15',
    })).toBeCloseTo(0.375);
    expect(creditCost({
      promptTokens: null,
      completionTokens: null,
      totalTokens: 1000,
      creditRate: '0.08',
    })).toBeCloseTo(0.08);
    expect(creditCost({
      promptTokens: 1000,
      completionTokens: 0,
      creditRate: 'x0',
    })).toBe(0);
    expect(creditCost({
      promptTokens: null,
      completionTokens: null,
      creditRate: 'x0.15',
    })).toBeNull();
    expect(creditCost({
      promptTokens: 1000,
      completionTokens: 0,
      creditRate: null,
    })).toBeNull();
  });

  it('fills a missing model name and credit rate from the current catalog', () => {
    const catalog = {
      'trae/deepseek-v4.1-flash': { modelName: 'DeepSeek V4 Flash', creditRate: 'x0.08' },
    };
    expect(applyUsageCatalog([
      {
        virtualModel: 'trae/deepseek-v4.1-flash',
        modelName: null,
        creditRate: null,
      },
      {
        model: 'wbai/hy3',
        modelName: '已记录',
        creditRate: 'x1',
      },
    ], {
      ...catalog,
      'wbai/hy3': { modelName: '别的名字', creditRate: 'x9' },
    })).toEqual([
      {
        virtualModel: 'trae/deepseek-v4.1-flash',
        modelName: 'DeepSeek V4 Flash',
        creditRate: 'x0.08',
      },
      {
        model: 'wbai/hy3',
        modelName: '已记录',
        creditRate: 'x1',
      },
    ]);
  });

  it('maps upstream errors, aborts and unknown models', () => {
    expect(
      mapRelayLog({ channel: 'wb', status: 'error', httpStatus: 502, error: 'boom' }),
    ).toMatchObject({ status: 'upstream_error', httpStatus: 502, errorSummary: 'boom' });

    expect(mapRelayLog({ channel: 'qoder', status: 'error', error: 'connect failed' })).toMatchObject({
      status: 'error',
      httpStatus: null,
      errorSummary: 'connect failed',
    });

    expect(mapRelayLog({ channel: 'qoder', status: 'aborted' })).toMatchObject({ status: 'aborted' });

    expect(mapRelayLog({ model: 'trae/missing', status: 'unknown-model' })).toMatchObject({
      status: 'error',
      httpStatus: 404,
      channelId: null,
      channelName: null,
      errorSummary: 'Unknown model: trae/missing',
    });
  });

  it('stores relay logs and filters them by relay channel id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-relay-log-'));
    tempDirs.push(dir);
    const database = createDatabase(path.join(dir, 'aihub.sqlite'));
    const repository = new Repository(database.raw);

    repository.insertLog(
      mapRelayLog({
        at: 1_700_000_000_000,
        channel: 'trae',
        channelLabel: 'Trae 国内版',
        model: 'trae/deepseek-v4.1-flash',
        upstreamModel: 'deepseek-v4.1-flash',
        stream: true,
        status: 'ok',
        durationMs: 321,
      }),
    );
    repository.insertLog({
      createdAt: 1_700_000_001,
      virtualModel: 'Alpha/m1',
      channelId: 'channel-1',
      channelName: 'Alpha',
      protocol: 'openai',
      upstreamModel: 'm1',
      stream: false,
      status: 'ok',
      httpStatus: 200,
      durationMs: 10,
      errorSummary: null,
    });

    const relayRows = repository.listLogs({
      limit: 500,
      offset: 0,
      channelId: 'relay:trae',
    }) as Array<Record<string, unknown>>;
    expect(relayRows).toHaveLength(1);
    expect(relayRows[0]).toMatchObject({
      virtualModel: 'trae/deepseek-v4.1-flash',
      channelId: 'relay:trae',
      channelName: 'Trae 国内版',
      protocol: 'relay',
      status: 'ok',
      stream: true,
    });

    database.close();
  });

  it('summarizes relay usage and keeps rows that have no tokens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-relay-usage-'));
    tempDirs.push(dir);
    const database = createDatabase(path.join(dir, 'aihub.sqlite'));
    const repository = new Repository(database.raw);

    repository.insertLog(
      mapRelayLog({
        at: 1_700_000_000_000,
        channel: 'trae',
        channelLabel: 'Trae 国内版',
        model: 'trae/deepseek',
        modelName: 'DeepSeek',
        upstreamModel: 'deepseek',
        status: 'ok',
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        creditRate: 'x0.08',
      }),
    );
    repository.insertLog(
      mapRelayLog({
        at: 1_700_000_100_000,
        channel: 'trae',
        channelLabel: 'Trae 国内版',
        model: 'trae/deepseek',
        modelName: 'DeepSeek',
        status: 'error',
        httpStatus: 429,
        error: 'soft_rate',
      }),
    );
    repository.insertLog({
      createdAt: 1_700_000_200,
      virtualModel: 'Alpha/m1',
      channelId: 'channel-1',
      channelName: 'Alpha',
      protocol: 'openai',
      upstreamModel: 'm1',
      stream: false,
      status: 'ok',
      httpStatus: 200,
      durationMs: 10,
      errorSummary: null,
      promptTokens: 999,
      completionTokens: 999,
    });

    expect(repository.summarizeRelayUsage({})).toEqual([
      {
        channelId: 'relay:trae',
        channelName: 'Trae 国内版',
        model: 'trae/deepseek',
        modelName: 'DeepSeek',
        requests: 2,
        promptTokens: 10,
        completionTokens: 4,
      },
    ]);

    const entries = repository.listLogs({ limit: 20, offset: 0, protocol: 'relay' }) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries.find((row) => row.status === 'upstream_error')).toMatchObject({
      promptTokens: null,
      completionTokens: null,
      creditRate: null,
    });
    expect(entries.find((row) => row.status === 'ok')).toMatchObject({
      modelName: 'DeepSeek',
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      creditRate: 'x0.08',
    });

    database.close();
  });
});
