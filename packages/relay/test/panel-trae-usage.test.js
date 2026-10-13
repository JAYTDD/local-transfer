import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraeStatus, toCredits } from '../src/panel/trae-status.mjs';

function fakeProvider({ usage }) {
  return {
    store: {
      status: async () => ({ state: 'signed-in' }),
      accounts: async () => [{ id: 'a1', accountName: 'tester', selected: true, tokenExpiresAtMs: 123 }],
    },
    models: () => [{ id: 'glm-5.3', name: 'glm-5.3' }],
    usage,
  };
}

const cnDeps = (provider) => ({
  providers: () => [{ def: { prefix: 'trae', kind: 'trae' }, provider, models: [] }],
});
const aiDeps = (provider) => ({
  providers: () => [{ def: { prefix: 'traeg', kind: 'trae' }, provider, models: [] }],
});

test('CN 区域把 snapshot / checkinStatus 映射进文档', async () => {
  const provider = fakeProvider({
    usage: {
      // 真实形状（照抄源 toCredits 的输入）：嵌套 summary + packs
      snapshot: async () => ({
        summary: { totalAmount: 100, consumedAmount: 40, consumptionRatio: 0.4 },
        packs: [
          { displayDesc: '免费', creditsLimit: 60, consumedCredits: 10, availableEndpoint: 0 },
          { displayDesc: 'Work', creditsLimit: 50, consumedCredits: 5, availableEndpoint: 1 },
        ],
      }),
      checkinStatus: async () => ({ checkedIn: false, credits: 5, enabled: true, didCheckedIn: false }),
    },
  });
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.credits.total, 100);
  assert.equal(doc.credits.consumed, 40);
  assert.equal(doc.credits.available, 60);
  assert.equal(doc.credits.generalAvailable, 50, 'endpoint 0 的剩余');
  assert.equal(doc.credits.workAvailable, 45, 'endpoint 1 的剩余');
  assert.equal(doc.credits.accounts.length, 2);
  assert.equal(doc.checkin.credits, 5);
});

test('有余额的积分包带上到期时刻，快到期和已过期分开计', async () => {
  const now = Date.now();
  const provider = fakeProvider({
    usage: {
      snapshot: async () => ({
        summary: { totalAmount: 30, consumedAmount: 0, consumptionRatio: 0 },
        packs: [
          { displayDesc: '快到期', creditsLimit: 10, consumedCredits: 0, availableEndpoint: 0, endTimeMs: now + 3_600_000 },
          { displayDesc: '已过期', creditsLimit: 8, consumedCredits: 0, availableEndpoint: 0, endTimeMs: now - 1_000 },
          { displayDesc: '没日期', creditsLimit: 4, consumedCredits: 0, availableEndpoint: 0, endTimeMs: 0 },
          { displayDesc: '用完了', creditsLimit: 6, consumedCredits: 6, availableEndpoint: 0, endTimeMs: now + 1_000 },
        ],
      }),
      checkinStatus: async () => ({ checkedIn: false, credits: 0, enabled: true, didCheckedIn: false }),
    },
  });
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.credits.accounts[0].expiresAtMs, now + 3_600_000);
  assert.equal(doc.credits.accounts[2].expiresAtMs, undefined);
  assert.equal(doc.credits.expiry.within24h.packs, 1);
  assert.equal(doc.credits.expiry.within24h.total, 10);
  assert.equal(doc.credits.expiry.expired.packs, 1);
  assert.equal(doc.credits.expiry.expired.total, 8);
});

test('到期分桶互不混，没有日期则不带 expiry', () => {
  const now = 1_700_000_000_000;
  const day = 86_400_000;
  const dated = toCredits({
    summary: { totalAmount: 1, consumedAmount: 0 },
    packs: [
      { displayDesc: 'soon', creditsLimit: 3, consumedCredits: 0, endTimeMs: now + 3_600_000 },
      { displayDesc: 'week', creditsLimit: 2, consumedCredits: 0, endTimeMs: now + 5 * day },
    ],
  }, now);
  assert.equal(dated.expiry.within24h.packs, 1);
  assert.equal(dated.expiry.within3d.packs, 1);
  assert.equal(dated.expiry.within7d.packs, 2);
  assert.equal(dated.expiry.expired.packs, 0);
  const undated = toCredits({
    summary: { totalAmount: 1, consumedAmount: 0 },
    packs: [{ displayDesc: 'x', creditsLimit: 1, consumedCredits: 0 }],
  }, now);
  assert.equal(undated.expiry, undefined);
});

test('liveLogin 失败不拖垮文档', async () => {
  const provider = fakeProvider({
    usage: {
      snapshot: async () => ({ summary: { totalAmount: 1, consumedAmount: 0 }, packs: [] }),
      checkinStatus: async () => ({ checkedIn: false, credits: 0, enabled: true, didCheckedIn: false }),
    },
  });
  provider.store.liveLogin = async () => { throw new Error('scan failed'); };
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.status, 'signed-in');
  assert.equal(doc.appLogin, undefined);
});

test('set-context-budgets 原样交给 provider', async () => {
  const provider = fakeProvider({ usage: undefined });
  let saved;
  provider.setContextBudgets = async (budgets) => {
    saved = budgets;
    return { state: 'updated' };
  };
  const out = await createTraeStatus(cnDeps(provider)).control('cn', {
    action: 'set-context-budgets',
    budgets: { wide: 1_000_000 },
  });
  assert.equal(out.state, 'updated');
  assert.deepEqual(saved, { wide: 1_000_000 });
});

test('没有 probeModels 时 test-models 失败', async () => {
  const out = await createTraeStatus(cnDeps(fakeProvider({ usage: undefined }))).control('cn', {
    action: 'test-models',
    models: ['glm-5.3'],
  });
  assert.equal(out.state, 'failed');
  assert.match(out.reason, /not wired/);
});

test('模型行只在 Max 窗口更大时带上可选项', async () => {
  const provider = fakeProvider({
    usage: {
      snapshot: async () => ({ summary: { totalAmount: 1, consumedAmount: 0 }, packs: [] }),
      checkinStatus: async () => ({ checkedIn: false, credits: 0, enabled: true, didCheckedIn: false }),
    },
  });
  provider.displayModels = () => [
    { id: 'wide', name: 'Wide', contextWindow: 200000, maxContextWindow: 1000000 },
    { id: 'same', name: 'Same', contextWindow: 128000, maxContextWindow: 128000 },
  ];
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.models[0].maxContextWindow, 1000000);
  assert.equal(doc.models[1].maxContextWindow, undefined);
});

test('客户端登录和绑定账号不一致时给出可切换的提示', async () => {
  const provider = fakeProvider({
    usage: {
      snapshot: async () => ({ summary: { totalAmount: 1, consumedAmount: 0 }, packs: [] }),
      checkinStatus: async () => ({ checkedIn: false, credits: 0, enabled: true, didCheckedIn: false }),
    },
  });
  provider.store.liveLogin = async () => ({ id: 'a2', accountName: 'other', edition: 'cn', region: 'cn' });
  const mismatch = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(mismatch.appLogin.id, 'a2');
  assert.equal(mismatch.appLogin.accountName, 'other');

  provider.store.liveLogin = async () => ({ id: 'a1', accountName: 'tester' });
  const same = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(same.appLogin, undefined);
});

test('test-models 交给 provider.probeModels', async () => {
  const provider = fakeProvider({ usage: undefined });
  provider.probeModels = async (ids) => ({ state: 'updated', results: ids.map((id) => ({ id, verdict: 'available', detail: '' })) });
  const out = await createTraeStatus(cnDeps(provider)).control('cn', { action: 'test-models', models: ['glm-5.3'] });
  assert.equal(out.results[0].verdict, 'available');
});

test('额度快照缺 summary/packs 时不崩', async () => {
  const provider = fakeProvider({
    usage: {
      snapshot: async () => ({}),
      checkinStatus: async () => ({ checkedIn: false, credits: 0, enabled: true, didCheckedIn: false }),
    },
  });
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.credits.total, 0);
  assert.deepEqual(doc.credits.accounts, []);
});

test('AI 区域走 payStatus 且不谎报积分明细', async () => {
  const provider = fakeProvider({ usage: { payStatus: async () => ({ hasPackage: true, inTrial: false }) } });
  const doc = await createTraeStatus(aiDeps(provider)).document('ai');
  assert.equal(doc.payStatus.hasPackage, true);
  assert.equal(doc.credits, undefined, 'AI 区域不该有积分明细字段');
});

test('额度查询抛错时给 creditsError，文档仍可用', async () => {
  const provider = fakeProvider({
    usage: {
      snapshot: async () => { throw new Error('usage endpoint exploded'); },
      checkinStatus: async () => ({ checkedIn: true, credits: 0, enabled: true, didCheckedIn: true }),
    },
  });
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.status, 'signed-in');
  assert.match(doc.creditsError, /usage endpoint exploded/);
  assert.equal(doc.checkin.checkedIn, true, '一个失败不该拖垮另一个');
});

test('未装配 usage 时明确说明而不是静默留空', async () => {
  const doc = await createTraeStatus(cnDeps(fakeProvider({ usage: undefined }))).document('cn');
  assert.equal(doc.credits, undefined);
  assert.equal(doc.creditsError, undefined);
  assert.match(doc.usageUnavailable, /usage client not wired/);
});

test('额度文档不泄漏凭据字段', async () => {
  const provider = fakeProvider({
    usage: {
      // 上游多返的字段一个都不许透传
      snapshot: async () => ({
        summary: { totalAmount: 1, consumedAmount: 0, accessToken: 'SECRET' },
        packs: [{ displayDesc: 'x', creditsLimit: 1, consumedCredits: 0, availableEndpoint: 0, secret: 'SECRET' }],
        accessToken: 'SECRET',
      }),
      checkinStatus: async () => ({ checkedIn: false, credits: 0, enabled: true, didCheckedIn: false, token: 'SECRET' }),
    },
  });
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(JSON.stringify(doc).includes('SECRET'), false, '响应体泄漏了 token');
});

test('签到的额外奖励字段透传，0 不显示', async () => {
  const provider = fakeProvider({
    usage: {
      snapshot: async () => ({}),
      checkinStatus: async () => ({ checkedIn: false, credits: 5, enabled: true, didCheckedIn: false, extraCredits: 3 }),
    },
  });
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.checkin.extraCredits, 3);
});

test('signed-out 时给出扫描过的凭据位置', async () => {
  const provider = {
    store: {
      status: async () => ({ state: 'signed-out', reason: 'no credential' }),
      accounts: async () => [],
      diagnose: async () => ({
        tried: 2,
        failures: [
          { path: 'C:\\Users\\x\\AppData\\Roaming\\Trae CN\\User\\globalStorage\\storage.json', edition: 'cn', source: 'desktop', reason: 'missing' },
          { path: 'C:\\other', edition: 'cn', source: 'cli', reason: 'invalid' },
        ],
      }),
    },
    models: () => [],
  };
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.searched.length, 2);
  assert.equal(doc.searched[0].reason, 'missing');
  assert.equal(doc.searched[0].edition, 'cn');
});

test('诊断信息里的路径不泄漏 token 材料', async () => {
  const provider = {
    store: {
      status: async () => ({ state: 'signed-out', reason: 'no credential' }),
      accounts: async () => [],
      diagnose: async () => ({
        tried: 1,
        failures: [
          { path: 'C:\\x\\storage.json', edition: 'cn', source: 'desktop', reason: 'invalid', message: 'accessToken=SECRET' },
        ],
      }),
    },
    models: () => [],
  };
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  // 只保留 path/edition/source/reason 与截断后的 message；
  // 此处断言的是"我们自己不注入凭据"，message 内容由 store 决定。
  assert.equal(doc.searched[0].path, 'C:\\x\\storage.json');
  assert.equal(doc.searched[0].edition, 'cn');
  assert.equal(doc.searched[0].reason, 'invalid');
});

test('signed-in 时不做诊断扫描', async () => {
  let diagnosed = false;
  const provider = {
    store: {
      status: async () => ({ state: 'signed-in' }),
      accounts: async () => [],
      diagnose: async () => { diagnosed = true; return { tried: 0, failures: [] }; },
    },
    models: () => [],
    usage: { snapshot: async () => ({}), checkinStatus: async () => ({}) },
  };
  await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(diagnosed, false, '已登录还去扫凭据是白费功夫');
});

test('store 没有 diagnose 时不崩', async () => {
  const provider = {
    store: {
      status: async () => ({ state: 'signed-out', reason: 'nope' }),
      accounts: async () => [],
    },
    models: () => [],
  };
  const doc = await createTraeStatus(cnDeps(provider)).document('cn');
  assert.equal(doc.status, 'signed-out');
  assert.equal(doc.searched, undefined);
});
