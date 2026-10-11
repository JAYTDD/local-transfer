import test from 'node:test';
import assert from 'node:assert/strict';

import { visibleModels } from '../src/providers/workbuddy.mjs';

const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('visibleModels：全局停用过滤', () => {
  assert.deepEqual(visibleModels(rows, { disabledModels: ['b'] }).map((m) => m.id), ['a', 'c']);
});

test('visibleModels：账号隐藏过滤', () => {
  assert.deepEqual(visibleModels(rows, { hidden: ['c'] }).map((m) => m.id), ['a', 'b']);
});

test('visibleModels：全局停用与账号隐藏叠加', () => {
  assert.deepEqual(
    visibleModels(rows, { disabledModels: ['a'], hidden: ['c'] }).map((m) => m.id),
    ['b'],
  );
});

test('visibleModels：空集合返回原引用', () => {
  assert.equal(visibleModels(rows), rows);
  assert.equal(visibleModels(rows, { disabledModels: [], hidden: [] }), rows);
});
