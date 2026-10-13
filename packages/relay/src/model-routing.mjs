/**
 * 模型名 → { provider, upstreamModel } 的路由解析。纯函数，便于单测
 * （gateway.mjs 的装配会读凭据、起 shim、拉目录，不要直接测它）。
 *
 * 严格校验是刻意的：前缀命中但 ID 不在该通道清单里时返回 null（由调用方
 * 回 404），**绝不把未知 ID 透传上游**——qoder 上游对未知模型名不报错，
 * 而是回一个无正文的空流，透传就把"模型名写错/显示名当 ID"静默成了
 * "空成功"。wb/trae 上游会报错，qoder 不报错，这里统一在网关层挡住。
 *
 * 提醒客户端的三个经典错误（404 文案里也会提示）：
 *   - 填了显示名（qoder/Qwen3.8-Flash）而不是 ID（qoder/qfmodel）
 *   - 大小写错（ID 大小写敏感）
 *   - 上游新增模型但本地目录还没刷新（先在面板刷新该通道）
 */
/** ID 优先；ID 对不上时，前缀内显示名唯一才改写成真实 ID。未知名仍然拒绝。 */
function resolveToken(models, token) {
  const byId = models.find((model) => model.id === token);
  if (byId) return byId.id;
  const byName = models.filter((model) => typeof model.name === 'string' && model.name !== '' && model.name === token);
  if (byName.length === 1) return byName[0].id;
  return null;
}

export function resolveModel(providers, modelId) {
  for (const p of providers) {
    const prefix = `${p.def.prefix}/`;
    if (modelId.startsWith(prefix)) {
      const upstreamModel = resolveToken(p.models, modelId.slice(prefix.length));
      if (!upstreamModel) return null;
      return { provider: p, upstreamModel };
    }
  }
  // 未带前缀时按顺序找第一个声明该模型的 provider（同样要求 ID 在清单里）
  for (const p of providers) {
    const upstreamModel = resolveToken(p.models, modelId);
    if (upstreamModel) return { provider: p, upstreamModel };
  }
  return null;
}

/**
 * 客户端带了 reasoning_effort 时：目录声明了档位且对不上，就去掉该字段，
 * 避免把非法档位送给上游。目录没声明档位时原样透传。
 */
export function fitReasoningEffort(body, model) {
  if (!body || typeof body !== 'object' || typeof body.reasoning_effort !== 'string') return body;
  const reasoning = model?.reasoning;
  const efforts = Array.isArray(reasoning?.supportedEfforts)
    ? reasoning.supportedEfforts
    : Array.isArray(reasoning?.supported)
      ? reasoning.supported
      : null;
  if (!efforts || efforts.includes(body.reasoning_effort)) return body;
  const next = { ...body };
  delete next.reasoning_effort;
  return next;
}

export function requestHasImage(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => Array.isArray(message?.content) && message.content.some((part) =>
    part?.type === 'image_url' || part?.type === 'image' || part?.type === 'input_image',
  ));
}
