import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 跨挂载的文档缓存（本会话内存级，刷新整页即清空；不进 localStorage）。
 *
 * 通道页离开就卸载、回来重挂载，没有这层缓存的话每次切页都要重新等一次上游
 * 额度查询——那几秒里页面只有骨架屏。命中缓存时先用上次的数据渲染，后台再刷新。
 */
const documents = new Map();

function initial(cacheKey) {
  const hit = cacheKey === undefined ? undefined : documents.get(cacheKey);
  return { cacheKey, data: hit ?? null, loading: hit === undefined, error: null };
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

/**
 * 页面级数据加载：挂载即取，暴露 reload。
 *
 * - fn(signal)：调用方把 signal 交给 api.*，卸载或键变化时中止在途请求
 *   （不留着 30s 的上游调用在后台堆）。
 * - cacheKey：命中缓存则首帧直接渲染（不显示骨架屏），刷新在后台进行。
 *   键变化时本 hook 会自行重置状态；同时调用方最好给页面加 key={variant}，
 *   让页面本地状态（提示条、忙标记）也跟着换区服清掉。
 * - 数据层约定：接口永不 500（异常都折进文档字段），这里的 error 只覆盖网络级失败。
 */
export function useAsyncData(fn, { cacheKey } = {}) {
  const [state, setState] = useState(() => initial(cacheKey));
  // 键变了但组件没重挂载：渲染期直接换成新键的状态（React 支持的派生状态写法）
  if (state.cacheKey !== cacheKey) setState(initial(cacheKey));

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async (signal) => {
    // 有缓存时不进 loading：数据照旧渲染，刷新在后台完成（stale-while-revalidate）
    setState((s) => ({ ...s, loading: s.data === null, error: null }));
    try {
      const data = await fnRef.current(signal);
      if (cacheKey !== undefined) documents.set(cacheKey, data);
      setState((s) => ({ ...s, data, loading: false, error: null }));
      return data;
    } catch (e) {
      // 主动中止（卸载/换键）不是失败，也不该写回状态
      if (isAbort(e)) return null;
      setState((s) => ({ ...s, loading: false, error: String(e?.message ?? e) }));
      return null;
    }
  }, [cacheKey]);

  /**
   * 本地更新已加载的文档：开关类操作用它做局部更新，避免整页重新拉取
   * （额度、签到、探针那些真上游请求没必要因为一个开关重跑一遍）。
   */
  const mutate = useCallback((updater) => {
    setState((s) => {
      if (s.data === null) return s;
      const data = typeof updater === 'function' ? updater(s.data) : updater;
      if (cacheKey !== undefined) documents.set(cacheKey, data);
      return { ...s, data };
    });
  }, [cacheKey]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  return { data: state.data, loading: state.loading, error: state.error, reload, mutate };
}
