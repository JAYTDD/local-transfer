/**
 * 面板"实时段"的等待预算。
 *
 * 通道文档里的额度/用量/签到状态都是**真上游请求**，慢的时候唯一的上限来自
 * vendored 客户端自己的 AbortSignal（Qoder 15s、Trae 30s、WorkBuddy 30s），
 * 那段时间里整份文档都发不出去，页面只剩骨架屏。这里给面板自己的等待设一个
 * 短预算：超时就当作"这次读不到"（调用方照常写 *Error 字段），模型列表、
 * 可见性、设置这些本地数据立刻可用。
 *
 * 底层请求不会被取消——vendored 的 fetchCredits 多数不接受 signal，我们只是
 * 不再等它：结果被丢弃，异常在这里就地吞掉，不会变成 unhandled rejection。
 */

/** 默认 3s；RELAY_PANEL_LIVE_TIMEOUT_MS 可覆盖，低于 200ms 视为未设置 */
export function liveBudgetMs() {
  const raw = Number(process.env.RELAY_PANEL_LIVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 200 ? raw : 3_000;
}

/**
 * @param {Promise<unknown>} promise 上游读取
 * @param {string} label 写进错误信息的可读名（会显示在面板的 *Error 字段里）
 */
export function withDeadline(promise, label, ms = liveBudgetMs()) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 未在 ${ms}ms 内返回（已放弃等待；上游请求可能仍在后台继续）`));
    }, ms);
    timer.unref?.();
    // 两个分支都挂上：超时之后原 promise 才 settle 也不会成为 unhandled rejection
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
