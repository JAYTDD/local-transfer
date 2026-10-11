import test from 'node:test';
import assert from 'node:assert/strict';

import { logRequest, resetLogs, setLogSink, snapshotLogs } from '../src/request-log.mjs';

test('sink：注册后收到日志条目，注销后不再回调', () => {
  resetLogs();
  const seen = [];
  setLogSink((entry) => seen.push(entry));
  try {
    logRequest({ channel: 'trae', channelLabel: 'Trae 国内版', model: 'trae/x', status: 'ok', durationMs: 12 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].channel, 'trae');
    assert.equal(seen[0].channelLabel, 'Trae 国内版');
    assert.equal(seen[0].model, 'trae/x');
    assert.equal(typeof seen[0].at, 'number');

    setLogSink(null);
    logRequest({ channel: 'trae', model: 'trae/y', status: 'ok', durationMs: 5 });
    assert.equal(seen.length, 1);
  } finally {
    setLogSink(null);
    resetLogs();
  }
});

test('sink：宿主抛错不影响环形缓冲与请求', () => {
  resetLogs();
  setLogSink(() => {
    throw new Error('host boom');
  });
  try {
    assert.doesNotThrow(() => logRequest({ channel: 'wb', model: 'wb/x', status: 'ok' }));
    assert.equal(snapshotLogs().entries.length, 1);
  } finally {
    setLogSink(null);
    resetLogs();
  }
});
