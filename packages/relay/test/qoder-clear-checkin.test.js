import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQoderProvider } from '../src/providers/qoder.mjs';

// 源 clearLogs（variants-CFI6-cGn.js:1334）只清 logs、保留 checkin 记录——
// 记录驱动"今日已领"判定与调度去重，清掉它会让当日按钮复活、重启后重签。
test('clearCheckInLogs 只清日志、保留签到记录（源 clearLogs 语义）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-clear-'));
  process.env.RELAY_STATE_DIR = dir;
  try {
    const provider = await createQoderProvider('cn');
    provider.checkInStore.patch({
      checkin: { lastDate: '2026-10-05', lastAt: 1, lastStatus: 'claimed', amount: 100 },
      logs: [{ date: '2026-10-05', status: 'claimed' }],
    });
    const out = provider.clearCheckInLogs();
    assert.equal(out.state, 'cleared');
    const saved = provider.checkInStore.get();
    assert.equal(saved.checkin.lastStatus, 'claimed', '签到记录必须保留');
    assert.deepEqual(saved.logs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
