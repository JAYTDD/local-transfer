import test from 'node:test';
import assert from 'node:assert/strict';

import { WORKBUDDY_RETRY, cancellableDelay, fetchWithRetry, localDelay } from '../src/retry.mjs';

/** 造一个按脚本返回状态码的 fetch 桩，并记录调用次数。 */
function scriptedFetch(statuses) {
  const calls = { count: 0 };
  const impl = async () => {
    const status = statuses[Math.min(calls.count, statuses.length - 1)];
    calls.count += 1;
    return { status, body: { cancel: async () => {} } };
  };
  return { impl, calls };
}

/** 立即返回、不真正等待的 sleep 桩。 */
const noSleep = async () => true;

test('WorkBuddy 首次 429、第二次成功：重试一次后返回成功响应', async () => {
  const { impl, calls } = scriptedFetch([429, 200]);
  const response = await fetchWithRetry('http://x', {}, {
    kind: 'workbuddy', fetchImpl: impl, sleep: noSleep, random: () => 0.5,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.count, 2);
});

test('WorkBuddy 连续 429 超过 maxRetries：返回 429，调用次数为 maxRetries + 1', async () => {
  const { impl, calls } = scriptedFetch([429]);
  const response = await fetchWithRetry('http://x', {}, {
    kind: 'workbuddy', fetchImpl: impl, sleep: noSleep, random: () => 0.5,
  });
  assert.equal(response.status, 429);
  assert.equal(calls.count, WORKBUDDY_RETRY.maxRetries + 1);
});

test('WorkBuddy 非 429 错误（500 / 400）：不重试，立即返回', async () => {
  for (const status of [500, 400]) {
    const { impl, calls } = scriptedFetch([status]);
    const response = await fetchWithRetry('http://x', {}, {
      kind: 'workbuddy', fetchImpl: impl, sleep: noSleep, random: () => 0.5,
    });
    assert.equal(response.status, status);
    assert.equal(calls.count, 1);
  }
});

test('WorkBuddy 429 但客户端已断开：不再发起后续重试', async () => {
  const { impl, calls } = scriptedFetch([429]);
  const controller = new AbortController();
  controller.abort();
  const response = await fetchWithRetry('http://x', {}, {
    kind: 'workbuddy', signal: controller.signal, fetchImpl: impl, sleep: noSleep, random: () => 0.5,
  });
  assert.equal(response.status, 429);
  assert.equal(calls.count, 1);
});

test('WorkBuddy 429 但退避期间客户端断开：不再发起后续重试', async () => {
  const { impl, calls } = scriptedFetch([429]);
  const controller = new AbortController();
  const sleep = async () => {
    controller.abort();
    return false;
  };
  const response = await fetchWithRetry('http://x', {}, {
    kind: 'workbuddy', signal: controller.signal, fetchImpl: impl, sleep, random: () => 0.5,
  });
  assert.equal(response.status, 429);
  assert.equal(calls.count, 1);
});

test('Trae 与 Qoder 的 429 同样退避重试', async () => {
  for (const kind of ['trae', 'qoder']) {
    const { impl, calls } = scriptedFetch([429, 200]);
    const response = await fetchWithRetry('http://x', {}, {
      kind, fetchImpl: impl, sleep: noSleep, random: () => 0.5,
    });
    assert.equal(response.status, 200);
    assert.equal(calls.count, 2);
  }
});

test('退避算法与 DSH localDelay 一致：指数增长、封顶、抖动范围', () => {
  const policy = WORKBUDDY_RETRY;
  assert.equal(localDelay(policy, 1, () => 0.5), 500);
  assert.equal(localDelay(policy, 2, () => 0.5), 1000);
  assert.equal(localDelay(policy, 3, () => 0.5), 2000);
  // 抖动区间：random 0 → 0.9 倍，random 1 → 1.1 倍
  assert.equal(localDelay(policy, 1, () => 0), 450);
  assert.equal(localDelay(policy, 1, () => 1), 550);
  // 封顶：即使指数很大也不超过 maxDelayMs
  assert.ok(localDelay(policy, 20, () => 1) <= policy.maxDelayMs);
});

test('cancellableDelay：signal 已中止时立即返回 false', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await cancellableDelay(10_000, controller.signal), false);
});

test('cancellableDelay：等待期间中止立即返回 false', async () => {
  const controller = new AbortController();
  const pending = cancellableDelay(10_000, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
});
