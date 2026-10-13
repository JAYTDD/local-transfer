/**
 * 订阅请求的用量摘取。
 *
 * 只记录上游 usage 里真正出现的 token，以及目录当时声明的积分倍率。
 * 不把 token 换算成扣费：三家都没有公开这个公式。
 */
import { Transform } from 'node:stream';

function finiteInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function rateNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `x${value}`;
}

/** 把一条 OpenAI usage 收成可落库的 token 数。没有任何数字时返回 undefined。 */
export function readUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const promptTokens = finiteInt(usage.prompt_tokens);
  const completionTokens = finiteInt(usage.completion_tokens);
  const totalTokens = finiteInt(usage.total_tokens);
  const details = usage.prompt_tokens_details;
  const cachedTokens = finiteInt(details?.cached_tokens) ?? finiteInt(usage.cached_tokens);
  if (
    promptTokens === undefined
    && completionTokens === undefined
    && totalTokens === undefined
    && cachedTokens === undefined
  ) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  };
}

/**
 * 目录行上的积分倍率。
 * Trae 用 creditMultiplier，WorkBuddy 用 billing.credits，Qoder 用 priceFactor。
 */
export function creditRateOf(model) {
  if (typeof model !== 'object' || model === null) return undefined;
  const multiplier = rateNumber(model.creditMultiplier);
  if (multiplier !== undefined) return multiplier;
  const credits = model.billing?.credits;
  if (typeof credits === 'string') {
    const trimmed = credits.replace(/\s*credits?$/i, '').trim();
    if (trimmed !== '') return trimmed.startsWith('x') || trimmed.startsWith('X') ? trimmed : `x${trimmed}`;
  }
  return rateNumber(model.priceFactor);
}

/** 请求结束时从当前目录快照显示名和倍率。对不上模型就留空。 */
export function snapshotModel(models, upstreamModel) {
  const model = (models ?? []).find((item) => item?.id === upstreamModel);
  if (model === undefined) return {};
  const modelName = typeof model.name === 'string' && model.name !== '' ? model.name : undefined;
  const creditRate = creditRateOf(model);
  return {
    ...(modelName === undefined ? {} : { modelName }),
    ...(creditRate === undefined ? {} : { creditRate }),
  };
}

function noteLine(line, store) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const payload = trimmed.slice(5).trim();
  if (payload === '' || payload === '[DONE]') return;
  try {
    const next = readUsage(JSON.parse(payload).usage);
    if (next) store.usage = next;
  } catch {
    /* 半行或非 JSON 不影响转发 */
  }
}

/**
 * 旁路扫描 SSE 里的 usage，原样交出每一个输入块。
 * WorkBuddy 的透传不能因为记账而改写字节。
 */
export function createUsageTap() {
  let pending = Buffer.alloc(0);
  const store = {};
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
      const newline = pending.lastIndexOf(0x0a);
      if (newline >= 0) {
        const text = pending.subarray(0, newline + 1).toString('utf8');
        pending = pending.subarray(newline + 1);
        for (const line of text.split('\n')) noteLine(line, store);
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (pending.length > 0) noteLine(pending.toString('utf8'), store);
      pending = Buffer.alloc(0);
      callback();
    },
  });
  return { stream, usage: () => store.usage };
}
