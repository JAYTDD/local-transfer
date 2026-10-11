/** 面板 API 客户端。所有路径走 AiHub 管理 API，相对当前 origin。 */

async function req(method, url, body, signal) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`bad JSON from ${url}: ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status} from ${url}`);
  return json;
}

/**
 * 通道文档只取当前区服/变体（?region= / ?variant=）：文档里的额度段是真上游
 * 请求，两个都取等于白等一份——页面只显示一份。
 */
export const api = {
  getHealth: (signal) => req('GET', '/api/admin/relay/panel/health', undefined, signal),
  getLogs: (signal) => req('GET', '/api/admin/relay/panel/logs', undefined, signal),
  getTrae: (region, signal) =>
    req('GET', `/api/admin/relay/panel/trae?region=${encodeURIComponent(region)}`, undefined, signal),
  getWorkBuddy: (variant, signal) =>
    req('GET', `/api/admin/relay/panel/workbuddy?variant=${encodeURIComponent(variant)}`, undefined, signal),
  getQoder: (variant, signal) =>
    req('GET', `/api/admin/relay/panel/qoder?variant=${encodeURIComponent(variant)}`, undefined, signal),
  postTraeRefresh: (region) =>
    req('POST', `/api/admin/relay/panel/trae/refresh?region=${encodeURIComponent(region)}`),
  postTraeCheckin: (region) =>
    req('POST', `/api/admin/relay/panel/trae/checkin?region=${encodeURIComponent(region)}`),
  postTraeControl: (region, action) =>
    req('POST', `/api/admin/relay/panel/trae/control?region=${encodeURIComponent(region)}`, action),
  postWorkBuddyControl: (variant, action) =>
    req('POST', `/api/admin/relay/panel/workbuddy/control?variant=${encodeURIComponent(variant)}`, action),
  postWorkBuddyProbe: (variant, model) =>
    req('POST', `/api/admin/relay/panel/workbuddy/probe?variant=${encodeURIComponent(variant)}`, { model }),
  postQoderRefresh: (variant) =>
    req('POST', `/api/admin/relay/panel/qoder/refresh?variant=${encodeURIComponent(variant)}`),
  postQoderControl: (variant, action) =>
    req('POST', `/api/admin/relay/panel/qoder/control?variant=${encodeURIComponent(variant)}`, action),
  postQoderProbe: (variant, model) =>
    req('POST', `/api/admin/relay/panel/qoder/probe?variant=${encodeURIComponent(variant)}`, { model }),
};
