import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 通道偏好存储与签到调度器（本次插件功能补齐移植的基础设施）

test('channel-prefs：patch 合并落盘，重开可读回，坏文件容错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  process.env.RELAY_STATE_DIR = dir;
  try {
    const { createChannelPrefs } = await import('../src/channel-prefs.mjs');
    const prefs = createChannelPrefs({ channel: 'trae', variant: 'cn' });
    prefs.patch({ enabledModelIds: ['glm-5.3'], enabled: false });
    prefs.patch({ enabled: true });
    const reopened = createChannelPrefs({ channel: 'trae', variant: 'cn' });
    assert.deepEqual(reopened.get().enabledModelIds, ['glm-5.3']);
    assert.equal(reopened.get().enabled, true);

    // 坏文件当空对象，不抛
    fs.writeFileSync(path.join(dir, 'prefs.trae.cn.json'), 'not json');
    assert.deepEqual(reopened.get(), {});
  } finally {
    delete process.env.RELAY_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkin-scheduler：UTC+8 时刻计算与 catchUp 判定', async () => {
  const { CheckInScheduler, beijingToday } = await import('../src/checkin-scheduler.mjs');
  // 2026-10-03 02:00 UTC = 10:00 UTC+8；minute=600（10:00）恰好此刻
  const now = new Date('2026-10-03T02:00:00Z');
  assert.equal(beijingToday(now), '2026-10-03');

  let enabled = true;
  let fired = 0;
  const scheduler = new CheckInScheduler({
    isEnabled: () => enabled,
    minute: () => 600,
    run: async () => { fired += 1; },
    lastRecord: () => undefined,
  });
  // 现在恰好是 10:00 UTC+8：下一次应排在明天
  const next = scheduler.nextRunAt('cn', now);
  const hours = (next - now.getTime()) / 3_600_000;
  assert.ok(hours > 23.9 && hours < 24.1, `nextRunAt 应约为 24h，实际 ${hours}h`);
  // 关闭时无下一次
  enabled = false;
  assert.equal(scheduler.nextRunAt('cn', now), undefined);
  // catchUp：没签过 → 执行一次
  enabled = true;
  await scheduler.catchUp('cn');
  assert.equal(fired, 1);
});

test('checkin-scheduler：今天已签（非 error）则 catchUp 不重复', async () => {
  const { CheckInScheduler, beijingToday } = await import('../src/checkin-scheduler.mjs');
  let fired = 0;
  const scheduler = new CheckInScheduler({
    isEnabled: () => true,
    minute: () => 600,
    run: async () => { fired += 1; },
    lastRecord: () => ({ lastDate: beijingToday(), lastStatus: 'claimed' }),
  });
  await scheduler.catchUp('cn');
  assert.equal(fired, 0);
});
