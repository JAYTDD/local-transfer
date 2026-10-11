import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, Repository } from '../src/db.js';
import { mapRelayLog } from '../src/relay.js';

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
    });
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
});
