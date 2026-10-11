/**
 * local-relay 自己的持久化状态目录。
 *
 * 刻意不用 resolveDshHome() 直接放文件名：DSH 插件也用那个目录、同样的文件名，
 * 而几个 store 的 persist() 是**全量覆盖写**（读整个文件 → 改一处 → 写回）。
 * 两个进程同时跑会互相把对方的改动整段抹掉；格式版本演进时还会互相判为旧格式
 * 而读成空，把对方的数据清空落盘。
 *
 * 所以状态落在 ~/.dsh/local-relay/ 这个子目录里，两个进程各写各的。
 * Trae 的凭据副本（~/.dsh/.trae-auth.<region>.json）是**例外**：那个共享是期望行为，
 * 两边都该复用同一份登录态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 状态目录（不创建）。RELAY_STATE_DIR 可覆盖，测试与多实例隔离都靠它。 */
export function stateDir() {
  return process.env.RELAY_STATE_DIR ?? path.join(os.homedir(), '.dsh', 'local-relay');
}

/** 确保状态目录存在，返回其路径 */
export function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 状态目录下的一个文件路径（不创建目录、不创建文件） */
export function statePath(filename) {
  return path.join(stateDir(), filename);
}
