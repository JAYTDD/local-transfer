import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_TTL_MS,
  collectRows,
  createCapabilityCache,
  toCapabilityRow,
} from '../src/model-capabilities.mjs';

test('Trae 目录：上下文、输出上限、思考档位和图片输入', () => {
  const row = toCapabilityRow({
    id: 'DeepSeek-V4-Flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 128000,
    maxTokens: 8192,
    reasoningSupported: true,
    reasoning: { supported: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    input: ['text', 'image'],
  }, { prefix: 'trae', label: 'Trae (国内版)' });
  assert.deepEqual(row, {
    id: 'trae/DeepSeek-V4-Flash',
    name: 'DeepSeek V4 Flash',
    prefix: 'trae',
    channel: 'Trae (国内版)',
    contextWindow: 128000,
    defaultReasoningEffort: 'medium',
    maxTokens: 8192,
    reasoning: { supported: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    supportsImages: true,
  });
});

test('WorkBuddy 目录：思考档位来自 supportedEfforts，未声明图片则不填', () => {
  const row = toCapabilityRow({
    id: 'hy3',
    name: 'GLM',
    contextWindow: 200000,
    maxTokens: 16384,
    supportsImages: false,
    reasoning: {
      supports: true,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
      canDisableThinking: true,
      onlyReasoning: false,
    },
  }, { prefix: 'wbai', label: 'WorkBuddy (国际版)' });
  assert.equal(row.contextWindow, 200000);
  assert.equal(row.maxTokens, 16384);
  assert.deepEqual(row.reasoning, {
    supported: true,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
  });
  assert.equal(row.supportsImages, undefined);
});

test('Qoder 目录：只声明支持推理、没有档位列表时不填 efforts', () => {
  const row = toCapabilityRow({
    id: 'ultimate',
    name: 'Ultimate',
    contextWindow: 256000,
    maxTokens: 32000,
    supportsImages: true,
    reasoning: { supports: true, canDisableThinking: false },
  }, { prefix: 'qoder', label: 'Qoder (国内版)' });
  assert.deepEqual(row.reasoning, { supported: true });
  assert.equal(row.supportsImages, true);
  assert.equal(row.maxTokens, 32000);
});

test('输出上限也认 maxOutputTokens 和 max_output_tokens', () => {
  assert.equal(
    toCapabilityRow({ id: 'hy3', name: 'GLM', maxOutputTokens: 64000 }, { prefix: 'wb', label: 'WorkBuddy' }).maxTokens,
    64000,
  );
  assert.equal(
    toCapabilityRow({ id: 'ultimate', name: 'Ultimate', max_output_tokens: 32768 }, { prefix: 'qoder', label: 'Qoder' }).maxTokens,
    32768,
  );
});

test('没有声明的能力字段不出现，空 id 丢弃', () => {
  const row = toCapabilityRow({ id: 'plain', name: '' }, { prefix: 'wb', label: 'WorkBuddy' });
  assert.deepEqual(row, { id: 'wb/plain', name: 'plain', prefix: 'wb', channel: 'WorkBuddy' });
  assert.equal(toCapabilityRow({ name: 'missing' }, { prefix: 'wb', label: 'WorkBuddy' }), null);
});

test('只读取 models()，停用模型留在 displayModels 里也不会出现', () => {
  const rows = collectRows([{
    prefix: 'qoder',
    label: 'Qoder',
    provider: {
      models: () => [{ id: 'on', name: 'On', contextWindow: 128000, maxTokens: 8192 }],
      displayModels: () => [
        { id: 'on', name: 'On' },
        { id: 'off', name: 'Off', contextWindow: 1000 },
      ],
    },
  }]);
  assert.deepEqual(rows.map((row) => row.id), ['qoder/on']);
});

test('5 分钟内不重复拉取；过期或 force 会再拉，且期间仍读最新 models()', async () => {
  let now = 1_000;
  let pulls = 0;
  let live = [{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100 }];
  const cache = createCapabilityCache({ ttlMs: CAPABILITY_TTL_MS, now: () => now });
  const refresh = async () => {
    pulls += 1;
    return [];
  };
  const read = () => collectRows([{
    prefix: 'wb',
    label: 'WorkBuddy',
    provider: { models: () => live },
  }]);

  await cache.load({ refresh, read });
  live = [{ id: 'b', name: 'B', contextWindow: 2000, maxTokens: 200 }];
  const cached = await cache.load({ refresh, read });
  assert.equal(pulls, 1);
  assert.equal(cached.models[0].id, 'wb/b');
  assert.equal(cached.fetchedAt, 1_000);

  now += CAPABILITY_TTL_MS;
  await cache.load({ refresh, read });
  assert.equal(pulls, 2);

  await cache.load({ force: true, refresh, read });
  assert.equal(pulls, 3);
});

test('刷新失败仍返回内存目录，并带上通道错误', async () => {
  const cache = createCapabilityCache({ now: () => 10 });
  const result = await cache.load({
    refresh: async () => [{ prefix: 'wb', label: 'WorkBuddy', message: '目录超时' }],
    read: () => collectRows([{
      prefix: 'wb',
      label: 'WorkBuddy',
      provider: {
        models: () => [{ id: 'hy3', name: 'hy3', contextWindow: 1000, maxTokens: 50 }],
      },
    }]),
  });
  assert.equal(result.models[0].id, 'wb/hy3');
  assert.deepEqual(result.errors, [{ prefix: 'wb', label: 'WorkBuddy', message: '目录超时' }]);
  assert.equal(result.fetchedAt, 10);
});

test('并发的第一次请求只拉取一次', async () => {
  let pulls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const cache = createCapabilityCache({ now: () => 1 });
  const refresh = async () => {
    pulls += 1;
    await gate;
    return [];
  };
  const read = () => [];
  const first = cache.load({ refresh, read });
  const second = cache.load({ refresh, read });
  assert.equal(pulls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(pulls, 1);
  assert.equal(a.fetchedAt, 1);
  assert.equal(b.fetchedAt, 1);
});
