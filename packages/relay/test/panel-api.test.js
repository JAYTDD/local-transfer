import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelApi } from '../src/panel/api.mjs';
import { logRequest, resetLogs } from '../src/request-log.mjs';

/** 造一个假的 providers 快照 */
function fakeProviders() {
  return [
    { def: { prefix: 'trae', label: 'Trae 国内版', kind: 'trae' }, models: [{ id: 'glm-5.3' }], error: undefined },
    { def: { prefix: 'wb', label: 'WorkBuddy 国内版', kind: 'workbuddy' }, models: [{ id: 'hy3' }], error: undefined },
  ];
}

/** 最小 req/res 桩，收集响应 */
function makeRes() {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; },
  };
  return res;
}

test('GET /panel/api/health returns provider summary without tokens', async () => {
  const api = createPanelApi({ providers: fakeProviders });
  const res = makeRes();
  const handled = await api.handle({ method: 'GET', url: '/panel/api/health', headers: {} }, res, '/panel/api/health');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.providers.length, 2);
  assert.equal(body.providers[0].prefix, 'trae');
  assert.equal(body.providers[0].models, 1);
  assert.equal(res.body.includes('token'), false);
});

test('health：端点来自后端宣告，模型数读实时目录并回写快照', async () => {
  const live = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
  const entry = {
    def: { prefix: 'trae', label: 'Trae 国内版', kind: 'trae' },
    models: [{ id: 'stale' }],
    provider: { models: () => live, enabled: () => true },
    error: undefined,
  };
  const providers = () => [entry];
  const api = createPanelApi({ providers, endpoint: () => 'http://127.0.0.1:8123/v1' });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/health', headers: {} }, res, '/panel/api/health');
  const body = JSON.parse(res.body);
  assert.equal(body.endpoint, 'http://127.0.0.1:8123/v1', '端点必须是后端宣告的权威值');
  assert.equal(body.providers[0].models, 3, '计数必须来自实时目录而非启动快照');
  assert.equal(entry.models.length, 3, '实时目录回写 entry.models，全局保持一致');
  // 未传 endpoint（旧式调用）时字段缺席，不编造
  const api2 = createPanelApi({ providers });
  const res2 = makeRes();
  await api2.handle({ method: 'GET', url: '/panel/api/health', headers: {} }, res2, '/panel/api/health');
  assert.equal('endpoint' in JSON.parse(res2.body), false);
});

test('health：qoder 摘要进入响应（configured→signed-in，目录兜底→degraded）', async () => {
  const providers = () => [{
    def: { prefix: 'qoder', label: 'Qoder 国内版', kind: 'qoder' },
    models: [],
    provider: {
      store: { status: async () => ({ state: 'configured' }) },
      models: () => [{ id: 'qfmodel' }],
      displayModels: () => [{ id: 'qfmodel' }],
      catalogSource: () => ({ source: 'fallback' }),
    },
    error: undefined,
  }];
  const api = createPanelApi({ providers });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/health', headers: {} }, res, '/panel/api/health');
  const p = JSON.parse(res.body).providers[0];
  assert.equal(p.status, 'signed-in');
  assert.equal(p.degraded, true, '目录为内置兜底时必须如实标注降级');
  assert.equal(typeof p.reason, 'string');
});

test('health：未配置凭据 → signed-out 带原因（前端黄点依据）', async () => {
  const providers = () => [{
    def: { prefix: 'wbai', label: 'WorkBuddy 国际版', kind: 'workbuddy' },
    models: [],
    provider: { displayModels: () => [], models: () => [], catalogSource: () => ({ source: 'live' }) },
    error: undefined,
  }];
  const api = createPanelApi({ providers });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/health', headers: {} }, res, '/panel/api/health');
  const p = JSON.parse(res.body).providers[0];
  assert.equal(p.status, 'signed-out');
  assert.equal(p.reason, 'no models discovered');
  assert.equal(p.degraded, undefined);
});

test('unknown panel path is not handled', async () => {
  const api = createPanelApi({ providers: fakeProviders });
  const res = makeRes();
  const handled = await api.handle({ method: 'GET', url: '/panel/api/nope', headers: {} }, res, '/panel/api/nope');
  assert.equal(handled, false);
});

test('GET /panel/api/logs 返回请求日志快照（newest-first，无正文）', async () => {
  resetLogs();
  logRequest({ channel: 'qoder', model: 'qoder/qfmodel', upstreamModel: 'qfmodel', stream: true, status: 'ok', durationMs: 12 });
  const api = createPanelApi({ providers: fakeProviders });
  const res = makeRes();
  const handled = await api.handle({ method: 'GET', url: '/panel/api/logs', headers: {} }, res, '/panel/api/logs');
  assert.equal(handled, true);
  const body = JSON.parse(res.body);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].model, 'qoder/qfmodel');
  assert.equal(body.entries[0].status, 'ok');
  resetLogs();
});

test('GET /panel/api/qoder lists both variants', async () => {
  const api = createPanelApi({ providers: fakeProviders });
  const res = makeRes();
  const handled = await api.handle({ method: 'GET', url: '/panel/api/qoder', headers: {} }, res, '/panel/api/qoder');
  assert.equal(handled, true);
  const body = JSON.parse(res.body);
  // fakeProviders 里没有 qoder 前缀，所以两个变体都应是"未配置"
  assert.ok(body.variants);
  assert.deepEqual(Object.keys(body.variants).sort(), ['cn', 'global']);
  assert.equal(body.variants.cn.status, 'signed-out');
});

/** 造一个可计数的 WorkBuddy 变体，用于验证"只算被请求的那一个" */
function wbEntry(prefix, modelId, { calls, boom = false }) {
  return {
    def: { prefix, label: prefix, kind: 'workbuddy' },
    models: [],
    provider: {
      displayModels: () => {
        calls.push(prefix);
        if (boom) throw new Error(`${prefix} 目录炸了`);
        return [{ id: modelId }];
      },
      models: () => [{ id: modelId }],
      catalogSource: () => ({ source: 'live' }),
    },
    error: undefined,
  };
}

test('GET /panel/api/workbuddy?variant= 只算被请求的变体（另一份不碰上游）', async () => {
  const calls = [];
  const providers = () => [wbEntry('wb', 'cn-model', { calls }), wbEntry('wbai', 'global-model', { calls })];
  const api = createPanelApi({ providers });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/workbuddy?variant=cn', headers: {} }, res, '/panel/api/workbuddy');
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body.variants), ['cn'], '响应里只该有被请求的变体');
  assert.equal(body.variants.cn.models[0].id, 'cn-model');
  assert.deepEqual(calls, ['wb'], '未被请求的变体根本不该被计算');
});

test('GET /panel/api/workbuddy 不带 variant 时两个变体都算', async () => {
  const calls = [];
  const providers = () => [wbEntry('wb', 'cn-model', { calls }), wbEntry('wbai', 'global-model', { calls })];
  const api = createPanelApi({ providers });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/workbuddy', headers: {} }, res, '/panel/api/workbuddy');
  assert.deepEqual(Object.keys(JSON.parse(res.body).variants).sort(), ['cn', 'global']);
  assert.deepEqual(calls.sort(), ['wb', 'wbai']);
});

test('GET /panel/api/workbuddy?variant=未知 → 404，不静默回落', async () => {
  const api = createPanelApi({ providers: fakeProviders });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/workbuddy?variant=nope', headers: {} }, res, '/panel/api/workbuddy');
  assert.equal(res.statusCode, 404);
});

test('一个变体算失败不牵连同一次请求里的另一个', async () => {
  const calls = [];
  const providers = () => [wbEntry('wb', 'cn-model', { calls }), wbEntry('wbai', 'x', { calls, boom: true })];
  const api = createPanelApi({ providers });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/workbuddy', headers: {} }, res, '/panel/api/workbuddy');
  assert.equal(res.statusCode, 200, '单个变体失败不该让整次请求 500');
  const body = JSON.parse(res.body);
  assert.equal(body.variants.cn.status, 'signed-in');
  assert.equal(body.variants.global.status, 'failed');
  assert.match(body.variants.global.reason, /炸了/);
});

test('GET /panel/api/trae?region= 只算被请求的区服', async () => {
  const api = createPanelApi({ providers: fakeProviders });
  const res = makeRes();
  await api.handle({ method: 'GET', url: '/panel/api/trae?region=ai', headers: {} }, res, '/panel/api/trae');
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body.regions), ['ai']);
});
