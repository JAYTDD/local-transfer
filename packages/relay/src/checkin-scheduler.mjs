/**
 * Qoder 自动签到调度器（照抄 dsh-qoder-connect 的 CheckInScheduler 语义，
 * 该类未从包根导出，这里按其对外行为重新实现）：
 *   - 每日一次，时刻 = checkInMinute（自 UTC+8 午夜起的分钟数，默认 600 = 10:00）
 *   - rearm() 在配置变化后重算下一次运行
 *   - catchUp() 补签：启动/配置变化时如果今天（UTC+8）还没成功签过，立即跑一次
 *   - nextRunAt(variantId) 给面板展示
 *
 * 插件原实现还带分钟级轮询对齐，这里用单个 setTimeout 精确等到下一次时刻，
 * 语义一致且更省。
 */
const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** 当前 UTC+8 的日期串（YYYY-MM-DD），与插件 getTodayDateString 同款 */
export function beijingToday(now = new Date()) {
  return beijingDate(now).toISOString().slice(0, 10);
}

/** 把真实时刻平移成"北京纪元"（其 UTC 字段即北京墙上时间），时区无关 */
function beijingDate(now) {
  return new Date(now.getTime() + BEIJING_OFFSET_MS);
}

export class CheckInScheduler {
  /**
   * @param {object} options
   * @param {(variantId: string) => boolean} options.isEnabled 该变体自动签到是否开启
   * @param {(variantId: string) => number} options.minute 该变体的签到时刻（分钟）
   * @param {(variantId: string) => Promise<{status: string, date: string}>} options.run 执行一次签到
   * @param {(variantId: string) => {lastDate?: string, lastStatus?: string} | undefined} options.lastRecord 最近一次记录（判断今天是否已签）
   * @param {() => void} [options.onChange] 状态变化通知（面板刷新）
   */
  constructor({ isEnabled, minute, run, lastRecord, onChange }) {
    this.isEnabled = isEnabled;
    this.minute = minute;
    this.run = run;
    this.lastRecord = lastRecord;
    this.onChange = onChange ?? (() => {});
    this.timers = new Map();
    this.running = new Set();
  }

  /** 距下一次 UTC+8 时刻的毫秒数（真实 epoch） */
  nextRunAt(variantId, now = new Date()) {
    if (!this.isEnabled(variantId)) return undefined;
    const bj = beijingDate(now);
    const minuteOfDay = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    const target = this.minute(variantId);
    const dayStartUtc = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
    // 今天的时刻已过（含恰好等于）就排到明天；秒级余量避免边界抖动
    const todayAt = dayStartUtc + target * 60_000;
    const nextBj = minuteOfDay < target ? todayAt : todayAt + DAY_MS;
    return nextBj - BEIJING_OFFSET_MS;
  }

  arm(variantId) {
    this.disarm(variantId);
    if (this.running.has(variantId)) return;
    const at = this.nextRunAt(variantId);
    if (at === undefined) return;
    const timer = setTimeout(async () => {
      this.timers.delete(variantId);
      await this.fire(variantId);
      this.arm(variantId);
    }, Math.max(0, at - Date.now()) + 1000);
    timer.unref?.();
    this.timers.set(variantId, timer);
  }

  async fire(variantId) {
    if (this.running.has(variantId)) return;
    this.running.add(variantId);
    try {
      const record = this.lastRecord(variantId);
      const today = beijingToday();
      if (record?.lastDate === today && record?.lastStatus !== 'error') return;
      await this.run(variantId);
    } finally {
      this.running.delete(variantId);
      this.onChange();
    }
  }

  /** 配置变化后重排 */
  rearm() {
    for (const variantId of this.variantIds ?? []) this.arm(variantId);
    this.onChange();
  }

  /** 启动补签：今天还没签且已开启就立刻补 */
  async catchUp(variantId) {
    if (!this.isEnabled(variantId)) return;
    const record = this.lastRecord(variantId);
    if (record?.lastDate === beijingToday() && record?.lastStatus !== 'error') return;
    await this.fire(variantId);
  }

  disarm(variantId) {
    const timer = this.timers.get(variantId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(variantId);
    }
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
