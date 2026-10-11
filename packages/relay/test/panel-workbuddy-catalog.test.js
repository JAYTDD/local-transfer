import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkBuddyStatus } from '../src/panel/workbuddy-status.mjs';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbcat-')), 'catalog.json');
}

async function realStore() {
  const { WorkBuddyCatalogStore } = await import('dsh-workbuddy-connect');
  return new WorkBuddyCatalogStore({ path: tmpFile() });
}

// 真实模型行必须带 contextWindow / maxTokens / supportsImages：
// 插件的 isSaved() 会逐个校验这些字段，缺一个整条记录读不回来。
const LIVE_ROW = {
  id: 'glm-5.3', name: 'glm-5.3', contextWindow: 200000, maxTokens: 8192,
  supportsImages: false, reasoning: { supports: true, supportedEfforts: [] },
  billing: { credits: 'x0.79 credits', badges: [], free: false },
};

function deps({ savedCatalogs, account = 'acct-1', models, catalogSource }) {
  const rows = models ?? [LIVE_ROW];
  const provider = {
    models: () => rows,
    savedCatalogs,
    account: async () => account,
    // 面板的 refresh 动作会调到它；真实 provider 在这里落盘
    async refreshModels() {
      if (account !== undefined && savedCatalogs) {
        savedCatalogs.set(account, { source: 'workbuddy:catalog', fetchedAtMs: Date.now(), models: rows });
      }
      return { models: rows, errors: [] };
    },
    ...(catalogSource === undefined ? {} : { catalogSource }),
  };
  const providers = [{ def: { prefix: 'wb', kind: 'workbuddy' }, provider, models: [] }];
  return { providers: () => providers };
}

test('刷新后目录写盘，重建 store 仍在（重启不再退回 fallback）', async () => {
  const store = await realStore();
  const st = createWorkBuddyStatus(deps({ savedCatalogs: store }));
  await st.control('cn', { action: 'refresh' });
  const { WorkBuddyCatalogStore } = await import('dsh-workbuddy-connect');
  const reopened = new WorkBuddyCatalogStore({ path: store.filePath() });
  const saved = reopened.get('acct-1');
  assert.notEqual(saved, undefined, '刷新后没有落盘');
  assert.equal(Array.isArray(saved.models), true);
});

test('无保存记录时 get 返回 undefined 而不抛', async () => {
  const store = await realStore();
  assert.equal(store.get('nobody'), undefined);
});

test('状态路径落在 local-relay 自己的目录，不碰 DSH 插件那份', async () => {
  const { createWorkBuddyProvider } = await import('../src/providers/workbuddy.mjs');
  const provider = await createWorkBuddyProvider('cn');
  const file = provider.savedCatalogs.filePath();
  assert.equal(file.includes('local-relay'), true, `catalog 路径没隔离：${file}`);
  assert.notEqual(path.basename(file), '.workbuddy-catalog.json', '不能复用插件自己的文件名');
});

test('两个变体各自的 catalog 文件不同名', async () => {
  const { createWorkBuddyProvider } = await import('../src/providers/workbuddy.mjs');
  const cn = (await createWorkBuddyProvider('cn')).savedCatalogs.filePath();
  const ai = (await createWorkBuddyProvider('global')).savedCatalogs.filePath();
  assert.notEqual(cn, ai);
});

test('uid 缺失的凭据不给账号键（不写进共享桶）', async () => {
  const { visibilityAccountOf } = await import('dsh-workbuddy-connect');
  // 插件的 visibilityAccountOf 只判 uid === ""，于是 uid 缺失会算出 'undefined:e1'
  // 这种真值字符串，让所有缺 uid 的账号共用一个桶。providers 层的 accountKeyOf 更严。
  assert.equal(visibilityAccountOf({ enterpriseId: 'e1' }), 'undefined:e1');
  const { createWorkBuddyProvider } = await import('../src/providers/workbuddy.mjs');
  const provider = await createWorkBuddyProvider('cn');
  // 本机已登录时 account() 会给出真实账号键；两种结果都合法，只要不是 'undefined:...' 形态
  const key = await provider.account();
  if (key !== undefined) {
    assert.equal(key.startsWith('undefined:'), false, `账号键是共享桶形态：${key}`);
  }
});

test('文档暴露目录来源', async () => {
  const st = createWorkBuddyStatus(deps({
    savedCatalogs: await realStore(),
    catalogSource: () => ({ source: 'fallback' }),
  }));
  const doc = await st.document('cn');
  assert.notEqual(doc.catalog, undefined);
  assert.equal(doc.catalog.source, 'fallback');
});

test('未装配 catalog store 时文档照常可用', async () => {
  const doc = await createWorkBuddyStatus(deps({ savedCatalogs: undefined })).document('cn');
  assert.equal(doc.status, 'signed-in');
  assert.equal(doc.catalog, undefined);
});

test('模型行仍保留倍率与免费标记', async () => {
  const model = { ...LIVE_ROW, billing: { credits: 'x0.79 credits', free: true, badges: ['新'] } };
  const doc = await createWorkBuddyStatus(deps({ savedCatalogs: undefined, models: [model] })).document('cn');
  assert.equal(doc.models[0].credits, 'x0.79');
  assert.equal(doc.models[0].free, true);
  assert.deepEqual(doc.models[0].badges, ['新']);
});

test('真实 provider：刷新后落盘，重建 provider 能读回（重启不退回 fallback）', async () => {
  const { createWorkBuddyProvider } = await import('../src/providers/workbuddy.mjs');
  const { WorkBuddyCatalogStore } = await import('dsh-workbuddy-connect');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbround-'));
  const before = process.env.RELAY_STATE_DIR;
  process.env.RELAY_STATE_DIR = dir;
  let provider;
  try {
    provider = await createWorkBuddyProvider('cn');
    await provider.start();
    await provider.refreshModels();
    const file = provider.savedCatalogs.filePath();
    assert.equal(fs.existsSync(file), true, '刷新后没有落盘');

    // 用同一个路径重开，模拟下次启动
    const reopened = new WorkBuddyCatalogStore({ path: file });
    const account = await provider.account();
    const saved = account === undefined ? undefined : reopened.get(account);
    assert.notEqual(saved, undefined, '落盘的目录读不回来——模型行字段可能不满足 isSaved 校验');
    assert.equal(saved.models.length > 0, true);
  } finally {
    // 必须无条件关闭：start() 起的是一个 loopback HTTP server（shim），漏关会让
    // node --test 的事件循环一直有活、**整个套件不退出**。上面任何断言失败都要走这里。
    await provider?.close();
    if (before === undefined) delete process.env.RELAY_STATE_DIR;
    else process.env.RELAY_STATE_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
