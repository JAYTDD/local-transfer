/**
 * 面板 API：把 local-relay 内部的 provider 状态暴露成 JSON。
 * 只做 HTTP 编排；各通道的业务组装在 ./trae-status.mjs 等模块里。
 */
import { createTraeStatus } from './trae-status.mjs';
import { createWorkBuddyStatus } from './workbuddy-status.mjs';
import { createQoderStatus } from './qoder-status.mjs';
import { snapshotLogs } from '../request-log.mjs';

/** 安全 JSON 响应 */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  if (!res.headers) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  }
  res.end(payload);
}

/**
 * 读请求体，1MB 上限。
 *
 * 移植进 AiHub 后宿主是 Fastify：它在进入本模块前已经把请求流解析并消费完，
 * 所以 `for await (const chunk of req)` 只会读到空。宿主把解析结果挂在
 * req.body 上（字符串或已解析对象），这里优先用它；独立运行时仍走流读取。
 */
async function readRequestBody(req, limit = 1024 * 1024) {
  if (req?.body !== undefined) {
    return typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 读实时目录并回写 entry（与 gateway.mjs currentModels 同语义），失败返回 undefined */
function liveModels(entry) {
  try {
    const live = entry.provider?.models?.();
    if (live !== undefined) entry.models = live;
    return live;
  } catch {
    return undefined;
  }
}

/**
 * 通道健康度文档：不含任何凭据字段。
 * - endpoint：网关的权威端点（面板可能被 Vite dev 服务器代理打开，
 *   window.location 不可信，端点只能由网关自己宣告）。
 * - models：实时目录计数，选集/禁用后总览与 /v1/models 永远一致。
 */
export function healthDocument(providers, endpoint) {
  return {
    ok: true,
    ready: true,
    ...(endpoint === undefined ? {} : { endpoint }),
    providers: providers.map((p) => ({
      prefix: p.def.prefix,
      label: p.def.label,
      kind: p.def.kind,
      models: (liveModels(p) ?? p.models).length,
      // 通道被面板关闭（Trae 区域启停）时如实标注，前端据此显示状态点
      ...(p.provider?.enabled?.() === false ? { enabled: false } : {}),
      ...(p.error === undefined ? {} : { error: p.error }),
    })),
  };
}

/** 前缀 → 摘要模块与变体的映射在 createPanelApi 内组装（依赖三个 status 实例） */

/**
 * 通道文档路由（Trae 的区服 / WorkBuddy、Qoder 的变体共用）。
 *
 * 关键点：**只算被请求的那一个**。文档里的额度段是真上游请求，两个变体串行
 * 计算意味着等两份上游返回，而页面只显示一份——耗时白白翻倍。带 ?param=key
 * 时只算这一个；不带时两个并发（并发而非串行：总耗时取最大值，不取和）。
 *
 * 单个变体的失败不牵连同一次请求里的另一个：这里把异常折成 failed 文档，
 * 与三个 status 模块"接口永不 500"的约定一致。
 */
async function documentRoute(req, res, { keys, document, param, field }) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const only = url.searchParams.get(param);
  const wanted = only === null ? keys : keys.filter((k) => k === only);
  if (wanted.length === 0) {
    return json(res, 404, { error: { message: `unknown ${param}: ${only}` } });
  }
  const out = {};
  await Promise.all(wanted.map(async (key) => {
    try {
      out[key] = await document(key);
    } catch (e) {
      out[key] = { status: 'failed', reason: String(e?.message ?? e), models: [] };
    }
  }));
  json(res, 200, { [field]: out });
}

export function createPanelApi(deps) {
  const routes = new Map();
  const traeStatus = createTraeStatus({ providers: deps.providers });
  const wbStatus = createWorkBuddyStatus({ providers: deps.providers });
  const qoderStatus = createQoderStatus({ providers: deps.providers });
  // 总览实况：前缀 → [status 模块, 变体]。summary 只做本地读（不发上游请求）。
  const SUMMARY_BY_PREFIX = {
    trae: [traeStatus, 'cn'],
    traeg: [traeStatus, 'ai'],
    wb: [wbStatus, 'cn'],
    wbai: [wbStatus, 'global'],
    qoder: [qoderStatus, 'cn'],
    qoderg: [qoderStatus, 'global'],
  };
  routes.set('GET /panel/api/logs', (req, res) => json(res, 200, snapshotLogs()));
  routes.set('GET /panel/api/health', async (req, res) => {
    const doc = healthDocument(deps.providers(), deps.endpoint?.());
    await Promise.all(doc.providers.map(async (p) => {
      const pair = SUMMARY_BY_PREFIX[p.prefix];
      if (!pair) return;
      try {
        const s = await pair[0].summary(pair[1]);
        // 只挑已知字段：摘要模块多返什么都不漏进响应体
        if (typeof s?.status === 'string') p.status = s.status;
        if (typeof s?.reason === 'string') p.reason = s.reason;
        if (s?.degraded === true) p.degraded = true;
      } catch { /* 摘要失败不影响健康度主体，状态点退回 error/enabled 判定 */ }
    }));
    json(res, 200, doc);
  });
  routes.set('GET /panel/api/trae', (req, res) => documentRoute(req, res, {
    keys: traeStatus.regions(), document: (region) => traeStatus.document(region), param: 'region', field: 'regions',
  }));
  routes.set('POST /panel/api/trae/refresh', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const region = url.searchParams.get('region') ?? 'cn';
    const out = await traeStatus.refresh(region);
    json(res, 200, out);
  });
  routes.set('POST /panel/api/trae/checkin', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const region = url.searchParams.get('region') ?? 'cn';
    json(res, 200, await traeStatus.checkin(region));
  });
  routes.set('POST /panel/api/trae/control', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const region = url.searchParams.get('region') ?? 'cn';
    const raw = await readRequestBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON body' } });
    }
    json(res, 200, await traeStatus.control(region, body));
  });
  routes.set('GET /panel/api/workbuddy', (req, res) => documentRoute(req, res, {
    keys: wbStatus.variants(), document: (v) => wbStatus.document(v), param: 'variant', field: 'variants',
  }));
  routes.set('POST /panel/api/workbuddy/control', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const variant = url.searchParams.get('variant') ?? 'cn';
    const raw = await readRequestBody(req);
    let action;
    try {
      action = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON body' } });
    }
    json(res, 200, await wbStatus.control(variant, action));
  });
  routes.set('POST /panel/api/workbuddy/probe', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const variant = url.searchParams.get('variant') ?? 'cn';
    const raw = await readRequestBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON body' } });
    }
    json(res, 200, await wbStatus.probe(variant, body.model));
  });
  routes.set('GET /panel/api/qoder', (req, res) => documentRoute(req, res, {
    keys: qoderStatus.variants(), document: (v) => qoderStatus.document(v), param: 'variant', field: 'variants',
  }));
  routes.set('POST /panel/api/qoder/control', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const variant = url.searchParams.get('variant') ?? 'cn';
    const raw = await readRequestBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON body' } });
    }
    json(res, 200, await qoderStatus.control(variant, body));
  });
  routes.set('POST /panel/api/qoder/refresh', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    json(res, 200, await qoderStatus.refresh(url.searchParams.get('variant') ?? 'cn'));
  });
  routes.set('POST /panel/api/qoder/probe', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const variant = url.searchParams.get('variant') ?? 'cn';
    const raw = await readRequestBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: { message: 'invalid JSON body' } });
    }
    json(res, 200, await qoderStatus.probe(variant, body.model));
  });

  return {
    /** 返回 true 表示已处理该请求 */
    async handle(req, res, pathname) {
      const key = `${req.method} ${pathname}`;
      const route = routes.get(key);
      if (!route) return false;
      try {
        await route(req, res);
      } catch (e) {
        json(res, 500, { error: { message: String(e?.message ?? e) } });
      }
      return true;
    },
  };
}
