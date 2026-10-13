/**
 * WorkBuddy 429 退避重试。
 *
 * DSH 直连时由 @deepseek-ai/dsh-llm-retry 在 agent 失败步上重试 RATE_LIMIT
 * （实测 maxRetries=5、首次延迟约 490ms），所以上游 soft_rate 对用户无感。
 * relay 没有那层宿主，必须在出站处自己补上；否则同一次 429 会直接透传给
 * 客户端，表现为"DSH 很流畅、经过中转就报限流"。
 *
 * 退避算法刻意与 dsh-llm-retry 的 localDelay 对齐：
 *   delay = min(initial * 2^(retry-1), max) * (1 - jitter + 2*jitter*random())
 * 三个订阅通道的 429 都重试；其他状态码不重试。
 */

/** 与 DSH 默认策略一致的 WorkBuddy 重试参数。 */
export const WORKBUDDY_RETRY = Object.freeze({
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
});

/** 第 retry 次重试前的等待毫秒数（retry 从 1 开始）。 */
export function localDelay(policy, retry, random = Math.random) {
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random();
  return Math.min(exponential * jitter, policy.maxDelayMs);
}

/**
 * 可取消的等待。signal 在等待期间触发时立即返回 false，定时器被清掉，
 * 不会留下悬挂的 handle 或多余的唤醒。
 */
export function cancellableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 出站 fetch + WorkBuddy 429 退避重试。
 *
 * 只在响应头返回 429 时重试，且此刻尚未向客户端写出任何内容，因此重试对
 * 客户端完全透明。重试耗尽后返回最后一个 Response，由调用方按原路径报错。
 * 连接失败等 fetch 抛错不在这里吞掉——调用方的 catch 维持现状。
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {object} [options]
 * @param {'trae'|'workbuddy'|'qoder'} [options.kind] 三个订阅通道都重试 429
 * @param {AbortSignal} [options.signal] 客户端断开信号
 * @param {typeof fetch} [options.fetchImpl] 测试注入
 * @param {typeof WORKBUDDY_RETRY} [options.policy] 测试注入
 * @param {() => number} [options.random] 测试注入
 * @param {(ms: number, signal?: AbortSignal) => Promise<boolean>} [options.sleep] 测试注入
 */
export async function fetchWithRetry(url, init, options = {}) {
  const {
    kind,
    signal,
    fetchImpl = fetch,
    policy = WORKBUDDY_RETRY,
    random = Math.random,
    sleep = cancellableDelay,
  } = options;

  const retryKind = kind === 'workbuddy' || kind === 'trae' || kind === 'qoder';
  let response = await fetchImpl(url, init);
  if (!retryKind || response.status !== 429) return response;

  for (let retry = 1; retry <= policy.maxRetries; retry += 1) {
    if (signal?.aborted) return response;
    const waited = await sleep(localDelay(policy, retry, random), signal);
    if (!waited) return response;
    // 丢弃上一次 429 的响应体，避免占用连接；最后一次的 body 保留给调用方读。
    try {
      await response.body?.cancel();
    } catch {
      /* body 已消费或不可取消：忽略 */
    }
    response = await fetchImpl(url, init);
    if (response.status !== 429) return response;
  }
  return response;
}
