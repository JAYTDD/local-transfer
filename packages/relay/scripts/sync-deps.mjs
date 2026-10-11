#!/usr/bin/env node
/**
 * 从 shims/node_modules 重建 node_modules。
 *
 * 为什么不入库：`node_modules/` 是派生物（.gitignore 忽略），
 * 而 `shims/node_modules/` 才是核心资产（提取的协议层 + 依赖桩，需要能 diff 审查）。
 * 全新 clone 之后没有 node_modules，直接启动宿主会 ERR_MODULE_NOT_FOUND，
 * 跑这个脚本即可。
 *
 * 用法：
 *   node scripts/sync-deps.mjs           # 缺就补，已有就跳过
 *   node scripts/sync-deps.mjs --force   # 先删后拷（改了桩之后用这个）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'shims', 'node_modules');
const DEST = path.join(ROOT, 'node_modules');
const force = process.argv.includes('--force');

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到源目录：${SRC}`);
  console.error('  shims/node_modules 是入库的核心资产，缺了说明仓库不完整。');
  process.exit(1);
}

if (fs.existsSync(DEST) && !force) {
  console.log(`✓ node_modules 已存在，跳过（要强制同步加 --force）`);
  process.exit(0);
}

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true });
  console.log('· 已删除旧的 node_modules');
}

fs.cpSync(SRC, DEST, { recursive: true });
const count = fs.readdirSync(DEST).length;
console.log(`✓ 已从 shims/node_modules 重建 node_modules（顶层 ${count} 项）`);
console.log('  提示：改了依赖桩之后必须重跑本脚本（或手动 cp），否则运行时读的还是旧副本。');
