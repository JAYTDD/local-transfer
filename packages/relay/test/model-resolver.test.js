import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../src/model-routing.mjs';

// 两个假 provider：注意 qoder 与 qoderg 共享部分 ID（qfmodel 两边都有），
// 前缀必须唯一命中；qfmodel 不带前缀时按顺序落在本项目靠前的 qoder 上。
function fakeProviders() {
  const mk = (prefix, ids) => ({
    def: { prefix },
    models: ids.map((id) => ({ id, name: `display-${id}` })),
  });
  return [
    mk('wb', ['deepseek-v4.1-flash', 'hy3']),
    mk('qoder', ['qfmodel', 'qmodel_latest']),
    mk('qoderg', ['qfmodel', 'ultimate']),
  ];
}

test('前缀 + 清单内 ID：正常路由', () => {
  const hit = resolveModel(fakeProviders(), 'wb/deepseek-v4.1-flash');
  assert.equal(hit.provider.def.prefix, 'wb');
  assert.equal(hit.upstreamModel, 'deepseek-v4.1-flash');
});

test('前缀命中但 ID 不在清单（显示名当 ID）：拒绝，不透传上游', () => {
  // qoder 上游对未知 ID 回静默空流，这里必须 404 而不是转发
  assert.equal(resolveModel(fakeProviders(), 'qoder/display-qfmodel'), null);
  assert.equal(resolveModel(fakeProviders(), 'qoder/Qwen3.8-Flash'), null);
});

test('ID 大小写敏感', () => {
  assert.equal(resolveModel(fakeProviders(), 'qoder/QFMODEL'), null);
  assert.equal(resolveModel(fakeProviders(), 'WB/deepseek-v4.1-flash'), null, '前缀也大小写敏感');
});

test('前缀命中但 ID 拼错：拒绝（即使别的前缀通道有这个 ID 也不串）', () => {
  // wbai 曾有 deepseek-v4.1-flash-sg 这类相邻 ID；写错前缀必须路由失败
  assert.equal(resolveModel(fakeProviders(), 'qoder/hy3'), null, 'hy3 是 wb 的，qoder 前缀不命中就不该透传');
});

test('无前缀 + 唯一 ID：按声明顺序落到第一个 provider', () => {
  const hit = resolveModel(fakeProviders(), 'hy3');
  assert.equal(hit.provider.def.prefix, 'wb');
  assert.equal(hit.upstreamModel, 'hy3');
});

test('无前缀 + 跨通道同名 ID：按顺序取第一个（qoder 在 qoderg 之前）', () => {
  const hit = resolveModel(fakeProviders(), 'qfmodel');
  assert.equal(hit.provider.def.prefix, 'qoder');
});

test('无前缀 + 未知 ID：拒绝', () => {
  assert.equal(resolveModel(fakeProviders(), 'no-such-model'), null);
});

test('qoderg 专有 ID 正常路由到国际通道', () => {
  const hit = resolveModel(fakeProviders(), 'qoderg/ultimate');
  assert.equal(hit.provider.def.prefix, 'qoderg');
  assert.equal(hit.upstreamModel, 'ultimate');
});
