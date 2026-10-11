/**
 * 通道偏好存储：每个 (channel, variant) 一份 JSON，落在 local-relay 自己的
 * 状态目录。对应 DSH 插件里由宿主 settings 持久化的那些配置字段
 * （模型选集、图片选集、上下文预算、最大上下文开关、探针同意、自动签到…）。
 *
 * 刻意做成 schema-free 的 patch 存储：调用方负责默认值与语义校验，
 * 这里只保证「读 → 合并 → 原子写回」与 JSON 解析容错（坏文件当空对象）。
 */
import fs from 'node:fs';
import { statePath } from './state-dir.mjs';

export function createChannelPrefs({ channel, variant }) {
  const file = statePath(`prefs.${channel}.${variant}.json`);

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {
    filePath: () => file,
    /** 当前偏好快照（浅拷贝） */
    get() {
      return { ...load() };
    },
    /** 合并一个补丁并落盘；写失败抛出（调用方决定要不要吞） */
    patch(partial) {
      const next = { ...load(), ...partial };
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
      return next;
    },
  };
}
