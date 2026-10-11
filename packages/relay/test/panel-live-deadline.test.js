import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline, liveBudgetMs } from '../src/panel/live-deadline.mjs';

test('withDeadline：按时返回的值原样透传', async () => {
  assert.equal(await withDeadline(Promise.resolve({ total: 1 }), 'X', 500).then((v) => v.total), 1);
});

test('withDeadline：超过预算就放弃等待，错误里带标签与预算', async () => {
  const never = new Promise(() => {});
  await assert.rejects(() => withDeadline(never, 'Qoder 额度', 30), /Qoder 额度 未在 30ms 内返回/);
});

test('withDeadline：上游自己的失败照常抛出（不被当成超时）', async () => {
  await assert.rejects(() => withDeadline(Promise.reject(new Error('HTTP 502')), 'X', 500), /HTTP 502/);
});

test('withDeadline：超时之后原 promise 才失败，不会变成 unhandled rejection', async () => {
  let fail;
  const late = new Promise((_, reject) => { fail = reject; });
  await assert.rejects(() => withDeadline(late, 'X', 20), /未在 20ms 内返回/);
  fail(new Error('上游迟到才失败'));
  await new Promise((r) => setTimeout(r, 20));
});

test('liveBudgetMs：默认 3s，可用环境变量覆盖，过小值视为未设置', () => {
  const old = process.env.RELAY_PANEL_LIVE_TIMEOUT_MS;
  try {
    delete process.env.RELAY_PANEL_LIVE_TIMEOUT_MS;
    assert.equal(liveBudgetMs(), 3_000);
    process.env.RELAY_PANEL_LIVE_TIMEOUT_MS = '500';
    assert.equal(liveBudgetMs(), 500);
    process.env.RELAY_PANEL_LIVE_TIMEOUT_MS = '50';
    assert.equal(liveBudgetMs(), 3_000, '低于 200ms 的预算会把正常读取也切掉，按未设置处理');
  } finally {
    if (old === undefined) delete process.env.RELAY_PANEL_LIVE_TIMEOUT_MS;
    else process.env.RELAY_PANEL_LIVE_TIMEOUT_MS = old;
  }
});
