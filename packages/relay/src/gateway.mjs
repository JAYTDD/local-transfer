/**
 * relay 模块入口（移植版）。
 *
 * 原 local-relay 是一个独立进程：src/server.mjs 自己监听 127.0.0.1:8790、
 * 自己校验 RELAY_KEY、自己分发 /v1、/panel、/panel/api 三组路由。
 * 移植进 AiHub 后不再自己监听端口——HTTP 入口由宿主（AiHub 的 Fastify 实例）
 * 提供，本模块只负责装配六个通道，并把处理能力暴露给宿主。
 *
 * 宿主需要的东西：
 *   - start() / stop()          装配与释放（读凭据、起 shim、拉目录）
 *   - channels()                本次实际装配的通道前缀（供宿主做健康度展示）
 *   - hasPrefix(model)          模型名是不是本模块的（六个前缀之一）
 *   - listModels()              六个通道的模型清单（宿主并入自己的 /v1/models）
 *   - modelCapabilities()       已启用模型的上下文 / 思考等级 / 输出上限（5 分钟缓存）
 *   - handleChat(body, res)     处理一次 chat 请求；body 由宿主解析后传入
 *   - panelApi                  控制面板的数据 API（由 AiHub 管理端调用）
 *
 * 与独立版本的差异只有进程入口那一层：请求体解析交给宿主（Fastify 已经
 * 消费了流），路由分发改由宿主完成，其余逻辑（模型路由、出站兼容、
 * SSE 规范化、非流式聚合、请求日志）与原实现一致；WorkBuddy 的 SSE 已符合
 * OpenAI 格式，因此在宿主转发时直接透传字节流。
 */
import { createTraeProvider } from './providers/trae.mjs';
import { createWorkBuddyProvider } from './providers/workbuddy.mjs';
import { createQoderProvider } from './providers/qoder.mjs';
import { createPanelApi } from './panel/api.mjs';
import { pipeline } from 'node:stream/promises';
import { fitReasoningEffort, requestHasImage, resolveModel } from './model-routing.mjs';
import { collectRows, createCapabilityCache, toPublicModelExtras } from './model-capabilities.mjs';
import { fetchWithRetry } from './retry.mjs';
import { rewriteClaudeCodeSignature, stripBillingHeader } from './workbuddy-compat.mjs';
import { logRequest, setLogSink } from './request-log.mjs';
import { createUsageTap, readUsage, snapshotModel } from './usage.mjs';

/** 六个通道前缀。宿主要求模型名带这些前缀时才交给本模块。 */
export const CHANNEL_PREFIXES = ['trae', 'traeg', 'wb', 'wbai', 'qoder', 'qoderg'];

/** 宿主的通道开关键（一个键控制该通道的国内 + 国际两个变体）。 */
export const CHANNEL_KEYS = ['trae', 'workbuddy', 'qoder'];

/** 各 provider 暴露的模型名前缀（避免不同上游模型同名冲突）。 */
const PROVIDERS = [
  { kind: 'trae', channel: 'trae', prefix: 'trae', label: 'Trae 国内版', build: () => createTraeProvider('cn') },
  { kind: 'trae', channel: 'trae', prefix: 'traeg', label: 'Trae 国际版', build: () => createTraeProvider('ai') },
  { kind: 'workbuddy', channel: 'workbuddy', prefix: 'wb', label: 'WorkBuddy 国内版', build: () => createWorkBuddyProvider('cn') },
  { kind: 'workbuddy', channel: 'workbuddy', prefix: 'wbai', label: 'WorkBuddy 国际版', build: () => createWorkBuddyProvider('global') },
  // Qoder 的 build 是 async：transport 要从包内未导出的路径动态加载
  { kind: 'qoder', channel: 'qoder', prefix: 'qoder', label: 'Qoder 国内版', build: () => createQoderProvider('cn') },
  { kind: 'qoder', channel: 'qoder', prefix: 'qoderg', label: 'Qoder 国际版', build: () => createQoderProvider('global') },
];

/**
 * 规范化一个 OpenAI 流式 chunk，使其严格符合标准形态。
 *
 * 上游（WorkBuddy / Trae）会带非标准字段，并**在每一帧都重复 `role`**：
 *   - ZCode 之类客户端按「出现 role 就开新段落」解析，于是每帧都开一个新
 *     思考块，界面上表现为满屏「思考·持续了几秒」。
 *   - DSH 的适配器对此容错，所以直连 DSH 看不出问题。
 *
 * 处理：role 只保留首帧；丢弃空 reasoning_content 与非标准键；
 * 无任何有效增量的空帧直接丢弃。
 */
export function normalizeChunk(chunk, seen) {
  if (!chunk || typeof chunk !== 'object') return null;
  const out = {
    id: chunk.id,
    object: chunk.object ?? 'chat.completion.chunk',
    created: chunk.created,
    model: chunk.model,
  };
  if (chunk.usage) out.usage = chunk.usage;
  out.choices = (chunk.choices ?? []).map((choice) => {
    const delta = choice?.delta ?? {};
    const clean = {};
    // role 只在首帧出现一次
    if (delta.role && !seen.role) { clean.role = delta.role; seen.role = true; }
    if (delta.content) clean.content = delta.content;
    if (delta.reasoning_content) clean.reasoning_content = delta.reasoning_content;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) clean.tool_calls = delta.tool_calls;
    const cleanChoice = { index: choice?.index ?? 0, delta: clean, finish_reason: choice?.finish_reason ?? null };
    return cleanChoice;
  });
  // 既无增量也无结束标记的空帧丢弃（客户端不需要）
  const hasDelta = out.choices.some((c) => Object.keys(c.delta).length > 0);
  const hasFinish = out.choices.some((c) => c.finish_reason);
  if (!hasDelta && !hasFinish) return null;
  return out;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * 装配一个 relay 网关实例。
 *
 * @param {object} options
 * @param {Record<string, boolean>} [options.channels] 通道开关，键见 CHANNEL_KEYS；
 *   缺省或未列出的通道视为关闭。宿主的总开关关闭时不应创建/启动本实例。
 * @param {() => string} [options.endpoint] 宿主对外宣告的 gateway 端点，供面板展示。
 */
export function createRelayGateway({ channels = {}, endpoint, onLog } = {}) {
  const state = { providers: [], ready: false };
  const capabilityCache = createCapabilityCache();

  const panelApi = createPanelApi({ providers: () => state.providers, endpoint });

  /** 通道是否对外服务（Trae 的区域启停；关闭的区域不列模型也不路由） */
  function serving(entry) {
    return entry.provider?.enabled?.() !== false;
  }

  /**
   * 取通道当前目录。entry.models 是启动快照；选集/可见性变化后 provider 里的
   * catalog 才是权威，所以每次取用都同步回 entry（health/面板也读它）。
   */
  function currentModels(entry) {
    const live = entry.provider?.models?.();
    if (live !== undefined) entry.models = live;
    return entry.models;
  }

  function listModels() {
    const data = [];
    for (const p of state.providers) {
      if (!serving(p)) continue;
      for (const m of currentModels(p)) {
        const displayName = typeof m.name === 'string' && m.name !== '' ? m.name : m.id;
        data.push({
          id: `${p.def.prefix}/${m.id}`,
          object: 'model',
          created: 0,
          owned_by: p.def.label,
          // 显示名。ZCode 之类的客户端在模型选择器里显示它，但**调用时必须用 id**。
          // 上游的 id 往往是内部代号（Qoder 的 qmodel_latest、WorkBuddy 的 hy3），
          // 没有这个字段就只能对着代号猜。缺 name 时回落到 id，并统一带上通道前缀。
          name: `${p.def.prefix}/${displayName}`,
          ...toPublicModelExtras(m),
        });
      }
    }
    return data;
  }

  /**
   * 已启用模型的能力快照。
   *
   * force 或距上次拉取已满 5 分钟时，对正在服务的通道并行 refreshModels。
   * 列表始终再读一次 models()，所以启用开关的变化不必等缓存过期。
   */
  function modelCapabilities({ force = false } = {}) {
    return capabilityCache.load({
      force,
      async refresh() {
        const targets = state.providers.filter(
          (entry) => serving(entry) && typeof entry.provider?.refreshModels === 'function',
        );
        const settled = await Promise.all(targets.map(async (entry) => {
          try {
            await entry.provider.refreshModels();
            return null;
          } catch (error) {
            return {
              prefix: entry.def.prefix,
              label: entry.def.label,
              message: String(error?.message ?? error),
            };
          }
        }));
        return settled.filter(Boolean);
      },
      read() {
        return collectRows(
          state.providers.filter(serving).map((entry) => ({
            prefix: entry.def.prefix,
            label: entry.def.label,
            provider: entry.provider,
          })),
        );
      },
    });
  }

  /**
   * 把上游 SSE 流聚合成一个非流式 chat.completion。
   * 三个插件的 shim 只输出流式（忽略 stream:false），所以非流式请求必须在这里聚合。
   */
  async function collectStream(response, fallbackModel) {
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finish = 'stop';
    let id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
    let model = fallbackModel;
    let created = Math.floor(Date.now() / 1000);
    let usage;
    let upstreamError;
    const toolCalls = new Map();

    const consume = (payload) => {
      if (payload === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(payload); } catch { return; }
      if (obj.error) { upstreamError = obj.error.message ?? JSON.stringify(obj.error); return; }
      if (obj.id) id = obj.id;
      if (obj.model) model = obj.model;
      if (obj.created) created = obj.created;
      if (obj.usage) usage = obj.usage;
      const choice = obj.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) content += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      for (const tc of delta?.tool_calls ?? []) {
        const key = tc.index ?? 0;
        const cur = toolCalls.get(key) ?? { id: tc.id ?? `call_${key}`, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name = tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        toolCalls.set(key, cur);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    };

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('data:')) consume(t.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith('data:')) consume(buffer.trim().slice(5).trim());

    if (upstreamError && !content && toolCalls.size === 0) throw new Error(upstreamError);

    const message = { role: 'assistant', content };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    }
    const finalFinish = toolCalls.size > 0 ? 'tool_calls' : (finish || 'stop');
    return {
      completion: {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finalFinish }],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: Math.ceil((content.length + reasoning.length) / 4), total_tokens: 0 },
      },
      usage: readUsage(usage),
    };
  }

  /** 逐行解析上游 SSE，规范化后转发。返回上游 usage（没有则为 undefined）。 */
  async function relayStream(body, res) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let captured;
    const seen = { role: false };
    const write = (obj) => res.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    const take = (obj) => {
      const next = readUsage(obj?.usage);
      if (next) captured = next;
    };

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') { res.write(encoder.encode('data: [DONE]\n\n')); continue; }
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        take(obj);
        if (obj.error) { write({ error: obj.error }); continue; }
        const norm = normalizeChunk(obj, seen);
        if (norm) write(norm);
      }
    }
    if (buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const obj = JSON.parse(payload);
          take(obj);
          const norm = normalizeChunk(obj, seen);
          if (norm) write(norm);
        } catch { /* 忽略尾部残片 */ }
      }
    }
    return captured;
  }

  /**
   * 处理一次 chat 请求。
   *
   * 与原实现的唯一差异：请求体由宿主解析好传进来（AiHub 的 Fastify 在进入
   * 本函数前已经消费了请求流），这里不再自己读 req。
   *
   * @param {object} body 已解析的 OpenAI chat 请求体
   * @param {import('node:http').ServerResponse} res 宿主提供的响应对象（Fastify 的 reply.raw）
   */
  async function handleChat(body, res) {
    const modelId = body?.model;
    for (const p of state.providers) currentModels(p);
    const startedAt = Date.now();
    let hit = resolveModel(state.providers.filter(serving), modelId);
    if (!hit && typeof modelId === 'string') {
      const entry = state.providers.find((item) => serving(item) && modelId.startsWith(`${item.def.prefix}/`));
      if (entry?.provider?.refreshModels) {
        try {
          await entry.provider.refreshModels();
          currentModels(entry);
          hit = resolveModel(state.providers.filter(serving), modelId);
        } catch { /* 刷新失败仍按未知模型返回 */ }
      }
    }
    if (!hit) {
      // 解析失败是最高频的用户错误（显示名当 ID、大小写错、目录未刷新），必须留痕
      logRequest({
        channel: null, model: modelId, upstreamModel: null, stream: body?.stream === true,
        status: 'unknown-model', durationMs: Date.now() - startedAt,
      });
      return json(res, 404, {
        error: {
          message: `Unknown model: ${modelId}. Take the id from GET /v1/models — ids are case-sensitive and the display name is not the id. If the model is new upstream, refresh its channel in the panel first.`,
        },
      });
    }
    const { provider, upstreamModel } = hit;
    const wantStream = body.stream === true;
    const logHit = (fields) => logRequest({
      channel: provider.def.prefix,
      model: modelId,
      upstreamModel,
      stream: wantStream,
      channelLabel: provider.def.label,
      ...snapshotModel(currentModels(provider), upstreamModel),
      ...fields,
    });
    // 客户端断开（取消生成/关页面）就中止上游，别让订阅额度白烧。
    // res 'close' 在正常完成后也会触发，那时 abort 是无害的 no-op。
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    // WorkBuddy 上游会整单拦截 system 里的 Claude Code 计费头块（wb/wbai 都拦）
    // 和旧版身份签名句（仅 wbai，VS Code 扩展每个请求都带）。出站前做最小修整，
    // 不含这些内容的请求逐字节原样；trae/qoder 不经过这段。
    let outbound = body;
    if (hit.provider.def.kind === 'workbuddy') {
      outbound = stripBillingHeader(outbound);
      if (hit.provider.def.prefix === 'wbai') outbound = rewriteClaudeCodeSignature(outbound);
    }
    const catalogModel = (provider.models ?? []).find((model) => model.id === upstreamModel);
    if (requestHasImage(outbound) && catalogModel?.supportsImages !== true && !catalogModel?.input?.includes('image') && catalogModel?.multimodal !== true) {
      logHit({
        status: 'error', httpStatus: 400, durationMs: Date.now() - startedAt,
        error: 'model does not accept images',
      });
      return json(res, 400, { error: { message: `Model "${modelId}" does not accept image input` } });
    }
    const upstreamBody = { ...fitReasoningEffort(outbound, catalogModel), model: upstreamModel, stream: true };

    let r;
    try {
      // 三个订阅通道的 429 按 DSH 的 llm-retry 语义退避重试；
      // 非 429 状态原样返回。
      r = await fetchWithRetry(
        `${provider.shim.baseUrl()}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.shim.token()}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(upstreamBody),
          signal: abort.signal,
        },
        { kind: hit.provider.def.kind, signal: abort.signal },
      );
    } catch (e) {
      logHit({
        status: abort.signal.aborted ? 'aborted' : 'error',
        durationMs: Date.now() - startedAt,
        ...(abort.signal.aborted ? {} : { error: String(e.message ?? e).slice(0, 200) }),
      });
      if (abort.signal.aborted) return; // 客户端已断开，写错误没有意义
      return json(res, 502, { error: { message: `Upstream failed: ${e.message}` } });
    }

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      logHit({
        status: 'error', httpStatus: r.status, durationMs: Date.now() - startedAt,
        error: text.slice(0, 200),
      });
      return json(res, r.status, { error: { message: `Upstream failed: ${text.slice(0, 400)}` } });
    }

    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (!r.body) return res.end();
      let usage;
      if (provider.def.kind === 'workbuddy') {
        // WorkBuddy shim already emits OpenAI-compatible SSE. The tap only
        // reads usage; every byte still reaches the client unchanged.
        const tap = createUsageTap();
        await pipeline(r.body, tap.stream, res);
        usage = tap.usage();
      } else {
        usage = await relayStream(r.body, res);
      }
      logHit({
        status: abort.signal.aborted ? 'aborted' : 'ok',
        durationMs: Date.now() - startedAt,
        ...usage,
      });
      if (!res.writableEnded) res.end();
      return;
    }

    try {
      const { completion, usage } = await collectStream(r, upstreamModel);
      logHit({
        status: 'ok', durationMs: Date.now() - startedAt,
        ...usage,
      });
      return json(res, 200, completion);
    } catch (e) {
      logHit({
        status: abort.signal.aborted ? 'aborted' : 'error', durationMs: Date.now() - startedAt,
        ...(abort.signal.aborted ? {} : { error: String(e.message ?? e).slice(0, 200) }),
      });
      if (abort.signal.aborted) return; // 客户端已断开
      return json(res, 502, { error: { message: `Upstream failed: ${e.message}` } });
    }
  }

  /** 按通道开关装配 provider（原 server.mjs 的 boot()，去掉 listen） */
  async function start() {
    setLogSink(typeof onLog === 'function' ? onLog : null);
    for (const def of PROVIDERS) {
      if (channels[def.channel] !== true) continue;
      const entry = { def, provider: null, shim: null, models: [], error: undefined };
      try {
        // await 对同步工厂无害，Qoder 的工厂是 async（动态加载未导出的 transport）
        const provider = await def.build();
        await provider.start();
        entry.provider = provider;
        entry.shim = provider.shim;
        entry.models = provider.models();
        // WB/Qoder 的凭据 sweep：账号变化自动重拉目录、失败目录自动重试（源 syncVariant 语义）
        provider.startSweep?.();
        console.log(`[relay] ✅ ${def.label.padEnd(18)} 模型 ${String(entry.models.length).padStart(3)} 个`);
      } catch (e) {
        entry.error = e.message;
        console.warn(`[relay] ⚠️  ${def.label.padEnd(18)} 不可用: ${e.message.slice(0, 140)}`);
      }
      state.providers.push(entry);
    }
    state.ready = true;
  }

  /** 释放全部 provider（原 server.mjs 的 shutdown()，去掉 server.close） */
  async function stop() {
    setLogSink(null);
    for (const p of state.providers) {
      try { await p.provider?.close(); } catch { /* 忽略 */ }
    }
    state.providers = [];
    state.ready = false;
  }

  return {
    start,
    stop,
    listModels,
    modelCapabilities,
    usageCatalog() {
      const labels = {};
      for (const entry of state.providers) {
        if (!serving(entry)) continue;
        for (const model of currentModels(entry)) {
          labels[`${entry.def.prefix}/${model.id}`] = snapshotModel([model], model.id);
        }
      }
      return labels;
    },
    handleChat,
    panelApi,
    /** 六个前缀（宿主用于路由分流与展示） */
    prefixes: CHANNEL_PREFIXES,
    /** 通道前缀 → 该通道是否已装配（宿主的路由分流用它二次确认） */
    isServingPrefix(prefix) {
      return state.providers.some((p) => p.def.prefix === prefix && serving(p));
    },
    /** 供宿主做健康度展示：每个已装配通道的模型数与错误 */
    status() {
      return state.providers.map((p) => ({
        prefix: p.def.prefix,
        label: p.def.label,
        channel: p.def.channel,
        models: currentModels(p).length,
        ...(p.provider?.enabled?.() === false ? { enabled: false } : {}),
        ...(p.error === undefined ? {} : { error: p.error }),
      }));
    },
    get ready() {
      return state.ready;
    },
  };
}
