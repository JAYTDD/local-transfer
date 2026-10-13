import { creditRateOf } from './usage.mjs';

/**
 * 订阅中转已启用模型的能力行。
 *
 * 只读各通道 `provider.models()`（与 /v1/models 同一批），不读面板用的全量目录。
 * 字段只取上游目录已经声明的上下文、输出上限、思考档位和图片输入；缺的不补。
 */

export const CAPABILITY_TTL_MS = 5 * 60 * 1000;

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function reasoningOf(model) {
  const reasoning = model?.reasoning;
  const rawEfforts = Array.isArray(reasoning?.supportedEfforts)
    ? reasoning.supportedEfforts
    : Array.isArray(reasoning?.supported)
      ? reasoning.supported
      : [];
  const efforts = rawEfforts.filter((item) => typeof item === 'string' && item !== '');
  const supported = reasoning?.supports === true || model?.reasoningSupported === true || efforts.length > 0;
  if (!supported) return undefined;
  const defaultEffort =
    typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort !== ''
      ? reasoning.defaultEffort
      : undefined;
  return {
    supported: true,
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
  };
}

function imageSupport(model) {
  if (model?.supportsImages === true) return true;
  if (Array.isArray(model?.input) && model.input.includes('image')) return true;
  if (model?.multimodal === true) return true;
  return undefined;
}

/**
 * 把一条目录对象收成能力行。没有可用 id 时返回 null。
 *
 * @param {object} model
 * @param {{ prefix: string, label: string }} meta
 */
export function toCapabilityRow(model, meta) {
  if (typeof model?.id !== 'string' || model.id === '') return null;
  const name = typeof model.name === 'string' && model.name !== '' ? model.name : model.id;
  const reasoning = reasoningOf(model);
  const supportsImages = imageSupport(model);
  const creditRate = creditRateOf(model);
  const defaultReasoningEffort = reasoning?.defaultEffort;
  const contextWindow = positiveNumber(model.contextWindow);
  // 三个目录的输出上限字段不一致：插件行是 maxTokens，
  // WorkBuddy 原始行是 maxOutputTokens，Qoder 发现行是 max_output_tokens。
  const maxTokens = positiveNumber(model.maxTokens)
    ?? positiveNumber(model.maxOutputTokens)
    ?? positiveNumber(model.max_output_tokens)
    ?? positiveNumber(model.max_tokens);
  return {
    id: `${meta.prefix}/${model.id}`,
    name,
    prefix: meta.prefix,
    channel: meta.label,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(creditRate === undefined ? {} : { creditRate }),
  };
}

/** `/v1/models` 上给客户端看的能力字段。没有声明的不写。 */
export function toPublicModelExtras(model) {
  const row = toCapabilityRow({ ...model, id: model?.id || 'model' }, { prefix: 'x', label: 'x' });
  if (!row) return {};
  return {
    ...(row.contextWindow === undefined ? {} : { context_window: row.contextWindow }),
    ...(row.maxTokens === undefined ? {} : { max_tokens: row.maxTokens }),
    ...(row.reasoning?.supported ? { reasoning: true } : {}),
    ...(row.reasoning?.efforts ? { reasoning_efforts: row.reasoning.efforts } : {}),
    ...(row.defaultReasoningEffort === undefined ? {} : { default_reasoning_effort: row.defaultReasoningEffort }),
    ...(row.supportsImages ? { supports_images: true } : {}),
    ...(row.creditRate === undefined ? {} : { credit_rate: row.creditRate }),
  };
}

/**
 * 只收集 `models()` 里的行。调用方负责先滤掉未在服务的通道。
 *
 * @param {Array<{ prefix: string, label: string, provider?: { models?: () => unknown[] } }>} entries
 */
export function collectRows(entries) {
  const models = [];
  for (const entry of entries) {
    const rows = entry.provider?.models?.() ?? [];
    for (const model of rows) {
      const row = toCapabilityRow(model, { prefix: entry.prefix, label: entry.label });
      if (row) models.push(row);
    }
  }
  return models;
}

/**
 * 上游目录拉取缓存。TTL 内跳过 refresh；过期或 force 才再拉。
 * 并发的第一次请求共用同一次 in-flight 拉取。刷新失败仍返回 read() 的内存目录。
 *
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createCapabilityCache({ ttlMs = CAPABILITY_TTL_MS, now = () => Date.now() } = {}) {
  let fetchedAt = null;
  let lastErrors = [];
  /** @type {Promise<void> | null} */
  let inflight = null;

  function isFresh(force) {
    return force !== true && fetchedAt !== null && now() - fetchedAt < ttlMs;
  }

  async function load({ force = false, refresh, read }) {
    if (!isFresh(force)) {
      if (!inflight) {
        inflight = (async () => {
          try {
            const errors = await refresh();
            lastErrors = Array.isArray(errors) ? errors : [];
          } catch (error) {
            lastErrors = [{ prefix: '', label: '', message: String(error?.message ?? error) }];
          } finally {
            fetchedAt = now();
            inflight = null;
          }
        })();
      }
      await inflight;
    }
    return {
      models: read(),
      errors: lastErrors,
      fetchedAt,
    };
  }

  return { load };
}
