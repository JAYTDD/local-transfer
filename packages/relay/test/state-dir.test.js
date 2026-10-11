import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir, statePath, ensureStateDir } from '../src/state-dir.mjs';

/** 临时改环境变量跑一段，跑完恢复 */
function withStateDir(value, fn) {
  const before = process.env.RELAY_STATE_DIR;
  if (value === undefined) delete process.env.RELAY_STATE_DIR;
  else process.env.RELAY_STATE_DIR = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.RELAY_STATE_DIR;
    else process.env.RELAY_STATE_DIR = before;
  }
}

test('状态目录不与 DSH 插件共用（必须在子目录里）', () => {
  withStateDir(undefined, () => {
    const dir = stateDir();
    const dshHome = path.join(os.homedir(), '.dsh');
    assert.notEqual(dir, dshHome, '状态目录不能就是 ~/.dsh 本身——那会和插件互相覆盖');
    assert.equal(dir.startsWith(dshHome + path.sep), true, '应位于 ~/.dsh 的子目录');
  });
});

test('RELAY_STATE_DIR 可覆盖', () => {
  const custom = path.join(os.tmpdir(), 'relay-state-test');
  withStateDir(custom, () => {
    assert.equal(stateDir(), custom);
    assert.equal(statePath('x.json'), path.join(custom, 'x.json'));
  });
});

test('statePath 只拼路径，不创建任何东西', () => {
  const custom = path.join(os.tmpdir(), 'relay-state-nonexistent-' + Date.now());
  withStateDir(custom, () => {
    statePath('probe.json');
    assert.equal(fs.existsSync(custom), false, 'statePath 不该有副作用');
  });
});

test('ensureStateDir 创建目录（含多级）', () => {
  const custom = path.join(os.tmpdir(), 'relay-state-mk-' + Date.now(), 'nested');
  withStateDir(custom, () => {
    try {
      const dir = ensureStateDir();
      assert.equal(dir, custom);
      assert.equal(fs.existsSync(custom), true);
      // 幂等：再调一次不抛
      ensureStateDir();
    } finally {
      fs.rmSync(path.dirname(custom), { recursive: true, force: true });
    }
  });
});
