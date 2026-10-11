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
export function resolveModel(providers, modelId) {
  for (const p of providers) {
    const prefix = `${p.def.prefix}/`;
    if (modelId.startsWith(prefix)) {
      const upstreamModel = modelId.slice(prefix.length);
      if (!p.models.some((m) => m.id === upstreamModel)) return null;
      return { provider: p, upstreamModel };
    }
  }
  // 未带前缀时按顺序找第一个声明该模型的 provider（同样要求 ID 在清单里）
  for (const p of providers) {
    if (p.models.some((m) => m.id === modelId)) return { provider: p, upstreamModel: modelId };
  }
  return null;
}
