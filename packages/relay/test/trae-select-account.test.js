import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTraeProvider } from '../src/providers/trae.mjs';

// 源插件由宿主在配置变化后重新 sync 目录；独立网关没有 sweep 兜底，
// 切换账号后必须立刻重拉，否则旧账号的目录/倍率继续对外服务。
test('selectAccount 触发目录刷新', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-select-'));
  process.env.RELAY_STATE_DIR = dir;
  try {
    const provider = createTraeProvider('cn');
    let refreshed = 0;
    provider.refreshModels = async () => { refreshed += 1; return {}; };
    const out = await provider.selectAccount('acc-1');
    assert.equal(out.state, 'updated');
    assert.equal(refreshed, 1, '切换账号必须重拉目录');
    // 偏好落盘，重启后恢复所选账号
    assert.equal(provider.prefs.get().selectedAccountId, 'acc-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
