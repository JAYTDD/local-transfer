import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createUsageTap, creditRateOf, readUsage, snapshotModel } from '../src/usage.mjs';

const SSE = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":1}}}\n\n',
  'data: [DONE]\n\n',
].join('');

test('旁路扫描取出 usage，输出字节与输入一致', async () => {
  const input = Buffer.from(SSE);
  const tap = createUsageTap();
  const chunks = [];
  await pipeline(
    Readable.from([input.subarray(0, 17), input.subarray(17, 40), input.subarray(40)]),
    tap.stream,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.deepEqual(Buffer.concat(chunks), input);
  assert.deepEqual(tap.usage(), {
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    cachedTokens: 1,
  });
});

test('没有 usage 的流不编造 token', async () => {
  const input = Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  const tap = createUsageTap();
  await pipeline(Readable.from([input]), tap.stream, new Writable({ write(_c, _e, cb) { cb(); } }));
  assert.equal(tap.usage(), undefined);
  assert.equal(readUsage(undefined), undefined);
  assert.equal(readUsage({}), undefined);
});

test('三种目录对象取出倍率，没有倍率时不填', () => {
  assert.equal(creditRateOf({ creditMultiplier: 0.08 }), 'x0.08');
  assert.equal(creditRateOf({ billing: { credits: 'x0.79 credits' } }), 'x0.79');
  assert.equal(creditRateOf({ priceFactor: 1.5 }), 'x1.5');
  assert.equal(creditRateOf({ priceFactor: 0 }), 'x0');
  assert.equal(creditRateOf({ id: 'plain', name: 'Plain' }), undefined);
  assert.deepEqual(
    snapshotModel(
      [{ id: 'hy3', name: 'GLM', billing: { credits: 'x0.79' } }, { id: 'other', name: 'Other' }],
      'hy3',
    ),
    { modelName: 'GLM', creditRate: 'x0.79' },
  );
  assert.deepEqual(snapshotModel([{ id: 'a', name: 'A' }], 'missing'), {});
});
