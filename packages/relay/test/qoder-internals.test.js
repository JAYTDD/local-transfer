import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { findQoderChunk } from '../src/providers/qoder.mjs';

const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempLib(prefix) {
  return fs.mkdtempSync(path.join(relayRoot, prefix));
}

test('按 b、x、y 三个导出找到 Qoder 内部模块，忽略浏览器包', async () => {
  const lib = tempLib('.tmp-qoder-chunk-');
  fs.writeFileSync(path.join(lib, 'client.js'), 'throw new Error("browser");\n');
  fs.writeFileSync(path.join(lib, 'decoy.js'), 'export function b() {}\n');
  fs.writeFileSync(path.join(lib, 'variants-deadbeef.js'), [
    'export function b() { return "transport"; }',
    'export function x() { return "machine"; }',
    'export function y() { return "validate"; }',
  ].join('\n'));

  const hit = await findQoderChunk(lib);
  assert.equal(path.basename(hit.file), 'variants-deadbeef.js');
  assert.equal(hit.mod.b(), 'transport');
  assert.equal(hit.mod.x(), 'machine');
  assert.equal(hit.mod.y(), 'validate');
  fs.rmSync(lib, { recursive: true, force: true });
});

test('没有或不止一个匹配模块时失败', async () => {
  const empty = tempLib('.tmp-qoder-empty-');
  fs.writeFileSync(path.join(empty, 'index.js'), 'export const ready = true;\n');
  await assert.rejects(() => findQoderChunk(empty), /找不到同时导出 b、x、y/);

  const many = tempLib('.tmp-qoder-many-');
  const body = 'export function b() {}\nexport function x() {}\nexport function y() {}\n';
  fs.writeFileSync(path.join(many, 'one.js'), body);
  fs.writeFileSync(path.join(many, 'two.js'), body);
  await assert.rejects(() => findQoderChunk(many), /有多个模块同时导出 b、x、y/);
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(many, { recursive: true, force: true });
});
