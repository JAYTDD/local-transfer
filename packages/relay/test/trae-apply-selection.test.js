import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as trae from 'dsh-connect-trae';
import { createTraeProvider } from '../src/providers/trae.mjs';

// 选集只影响 derive，不需要重新打上游——每次开关模型都全量重拉 remote+local
// 是白花两次上游请求。lastMerged 缺失时才允许回落到真正的网络刷新。
test('setModelSelection 用本地 derive，不打上游', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-select-'));
  process.env.RELAY_STATE_DIR = dir;
  try {
    const provider = createTraeProvider('cn');
    provider.lastMerged = trae.fallbackModelsFor('cn');
    provider.refreshModels = async () => { throw new Error('selection must not refetch'); };
    const firstId = provider.lastMerged[0].id;
    const out = await provider.setModelSelection([firstId]);
    assert.equal(out.state, 'updated');
    assert.deepEqual(provider.models().map((m) => m.id), [firstId]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lastMerged 缺失时回落到 refreshModels（首次使用前）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-select-'));
  process.env.RELAY_STATE_DIR = dir;
  try {
    const provider = createTraeProvider('cn');
    let refetched = 0;
    provider.refreshModels = async () => { refetched += 1; return {}; };
    await provider.setImageSelection(['any']);
    assert.equal(refetched, 1, '没有合并目录时必须回落到网络刷新');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
