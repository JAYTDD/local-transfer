import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCatalog, deriveCatalog } from 'dsh-connect-trae';
import { dropDeadModels } from '../src/providers/trae.mjs';

const wire = (resolved, keys) => ({ resolved, callableKeys: new Set(keys) });

test('sanitizeCatalog 丢掉 @1m 变体', () => {
  assert.deepEqual(sanitizeCatalog([{ id: 'glm-5.3@1m' }, { id: 'glm-5.3' }]).map((m) => m.id), ['glm-5.3']);
});

test('sanitizeCatalog 丢掉遗留 baseModelId / maxContext 行', () => {
  const out = sanitizeCatalog([{ id: 'a', baseModelId: 'x' }, { id: 'b', maxContext: true }, { id: 'c' }]);
  assert.deepEqual(out.map((m) => m.id), ['c']);
});

test('deriveCatalog 空选集回落到整个目录', () => {
  assert.equal(deriveCatalog([{ id: 'a' }, { id: 'b' }], new Set()).length, 2);
});

test('deriveCatalog 有选集时按选集过滤', () => {
  assert.deepEqual(deriveCatalog([{ id: 'a' }, { id: 'b' }], new Set(['b'])).map((m) => m.id), ['b']);
});

test('deriveCatalog 预算等于 maxContextWindow 时提升 contextWindow', () => {
  const out = deriveCatalog([{ id: 'a', maxContextWindow: 200000 }], new Set(), { a: 200000 });
  assert.equal(out[0].contextWindow, 200000);
});

test('dropDeadModels 未 resolve 时不过滤（首次 discovery 前没有证据）', () => {
  const rows = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  assert.equal(dropDeadModels(rows, wire(false, [])).length, 2);
});

test('dropDeadModels 剔掉 id 与 name 都不在可调用集里的模型', () => {
  const rows = [{ id: 'alive', name: 'Alive' }, { id: 'Doubao-Seed-Code', name: 'Doubao-Seed-Code' }];
  const out = dropDeadModels(rows, wire(true, ['alive']));
  assert.deepEqual(out.map((m) => m.id), ['alive']);
});

test('dropDeadModels 认 name 也认 id（上游两者拼写可能不同）', () => {
  const rows = [{ id: 'Some-Ugly-Id', name: 'Pretty Name' }];
  assert.equal(dropDeadModels(rows, wire(true, ['pretty name'])).length, 1, '应由 name 命中');
  assert.equal(dropDeadModels(rows, wire(true, ['some-ugly-id'])).length, 1, '应由 id 命中');
});

test('dropDeadModels 大小写与空白不敏感', () => {
  const rows = [{ id: '  GLM-5.3  ', name: 'glm-5.3' }];
  assert.equal(dropDeadModels(rows, wire(true, ['glm-5.3'])).length, 1);
});

test('dropDeadModels resolved 但可调用集为空时清空全部（说明全部是死模型）', () => {
  const rows = [{ id: 'a', name: 'A' }];
  assert.deepEqual(dropDeadModels(rows, wire(true, [])), []);
});

test('dropDeadModels 容忍缺 name 的行', () => {
  const rows = [{ id: 'a' }];
  assert.equal(dropDeadModels(rows, wire(true, ['a'])).length, 1);
  assert.equal(dropDeadModels(rows, wire(true, ['zzz'])).length, 0);
});
