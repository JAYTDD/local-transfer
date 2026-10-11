import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraeStatus } from '../src/panel/trae-status.mjs';

/** 造一个 trae provider 桩：带可选凭据 store */
function traeProvider(region, models, store) {
  return {
    def: { prefix: region === 'cn' ? 'trae' : 'traeg', label: `Trae ${region}`, kind: 'trae' },
    provider: {
      id: region === 'cn' ? 'trae' : 'trae-global',
      store,
      models: () => models,
      refreshModels: async () => ({ models, errors: [] }),
    },
    models,
  };
}

/** 已登录的 store 桩 */
function signedInStore(accountName = '示例账号') {
  const account = {
    id: 'acct-1',
    accountName,
    edition: 'cn',
    region: 'cn',
    source: 'desktop',
    tokenExpiresAtMs: 1800000000000,
    selected: true,
  };
  return {
    status: async () => ({ state: 'signed-in', edition: 'cn', expiresAtMs: 1800000000000, source: 'desktop' }),
    accounts: async () => [account],
  };
}

/** 未登录的 store 桩 */
function signedOutStore() {
  return {
    status: async () => ({ state: 'signed-out', reason: 'no-credential' }),
    accounts: async () => [],
  };
}

test('regions lists both trae regions', () => {
  const st = createTraeStatus({ providers: () => [traeProvider('cn', [{ id: 'glm-5.3' }])] });
  assert.deepEqual(st.regions().sort(), ['ai', 'cn']);
});

test('document reports signed-out with reason when provider missing', async () => {
  const st = createTraeStatus({ providers: () => [] });
  const doc = await st.document('cn');
  assert.equal(doc.status, 'signed-out');
  assert.deepEqual(doc.models, []);
  assert.match(doc.reason, /region not configured/);
});

test('document reports signed-in with real account from store', async () => {
  const st = createTraeStatus({
    providers: () => [traeProvider('cn', [{ id: 'glm-5.3', name: 'GLM-5.3' }], signedInStore())],
  });
  const doc = await st.document('cn');
  assert.equal(doc.status, 'signed-in');
  assert.equal(doc.accountName, '示例账号');
  assert.equal(doc.tokenExpiresAtMs, 1800000000000);
  assert.equal(doc.accounts.length, 1);
  assert.equal(doc.models.length, 1);
  assert.equal(doc.models[0].id, 'glm-5.3');
});

test('document never leaks token material', async () => {
  const st = createTraeStatus({
    providers: () => [traeProvider('cn', [{ id: 'glm-5.3' }], signedInStore())],
  });
  const text = JSON.stringify(await st.document('cn'));
  for (const needle of ['accessToken', 'refreshToken', 'Bearer']) {
    assert.equal(text.includes(needle), false, `leaked ${needle}`);
  }
});

test('document reports signed-out when store says so', async () => {
  const st = createTraeStatus({
    providers: () => [traeProvider('cn', [{ id: 'glm-5.3' }], signedOutStore())],
  });
  const doc = await st.document('cn');
  assert.equal(doc.status, 'signed-out');
  assert.equal(doc.reason, 'no-credential');
  assert.equal(doc.models.length, 1, 'models still listed even when signed out');
});

test('refresh proxies provider refreshModels', async () => {
  const st = createTraeStatus({
    providers: () => [traeProvider('cn', [{ id: 'glm-5.3' }], signedInStore())],
  });
  const out = await st.refresh('cn');
  assert.equal(out.models.length, 1);
});

test('document survives a provider that failed to start', async () => {
  const broken = {
    def: { prefix: 'traeg', label: 'Trae 国际版', kind: 'trae' },
    provider: null,
    models: [],
    error: 'trae model catalog cannot be empty',
  };
  const st = createTraeStatus({ providers: () => [broken] });
  const doc = await st.document('ai');
  assert.equal(doc.status, 'signed-out');
  assert.deepEqual(doc.models, []);
  assert.match(doc.reason, /catalog cannot be empty/);
});
