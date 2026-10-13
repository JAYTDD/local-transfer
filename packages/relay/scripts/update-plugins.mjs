/**
 * 从 npm 替换三个已入库的订阅插件。手写的 DSH 桩不动。
 *
 *   node scripts/update-plugins.mjs
 *   node scripts/update-plugins.mjs dsh-connect-trae@3.4.2
 */
import { spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOWED_PLUGINS = [
  'dsh-connect-trae',
  'dsh-workbuddy-connect',
  'dsh-qoder-connect',
];

export function parsePluginSpec(token) {
  const at = token.lastIndexOf('@');
  if (at <= 0) return { name: token, version: null };
  return { name: token.slice(0, at), version: token.slice(at + 1) };
}

export function resolveSpecs(tokens) {
  const specs = tokens.length === 0
    ? ALLOWED_PLUGINS.map((name) => ({ name, version: null }))
    : tokens.map(parsePluginSpec);
  const seen = new Set();
  for (const spec of specs) {
    if (!ALLOWED_PLUGINS.includes(spec.name)) {
      throw new Error(`不在允许更新的插件列表里：${spec.name}`);
    }
    if (spec.version === '') throw new Error(`版本号为空：${spec.name}`);
    if (seen.has(spec.name)) throw new Error(`重复指定了插件：${spec.name}`);
    seen.add(spec.name);
  }
  return specs;
}

export function integrityMatches(buffer, integrity) {
  const dash = integrity.indexOf('-');
  if (dash <= 0) return false;
  const algo = integrity.slice(0, dash);
  let actual;
  let expected;
  try {
    actual = createHash(algo).update(buffer).digest();
    expected = Buffer.from(integrity.slice(dash + 1), 'base64');
  } catch {
    return false;
  }
  if (actual.length === 0 || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** npm pack 的路径是 package/...。返回替换进 shims 的相对路径，目录和危险项返回 null。 */
export function shimPathFromTar(entryName) {
  const normalized = entryName.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!normalized.startsWith('package/') || normalized.endsWith('/')) return null;
  const rel = normalized.slice('package/'.length);
  const parts = rel.split('/');
  if (rel === '' || parts.includes('..') || parts.includes('node_modules')) return null;
  return rel;
}

function readSpecifier(source, start) {
  const head = source.slice(start, start + 500);
  const match = /^(?:import|export)\s+(?:type\s+)?(?:[\s\S]{0,400}?\sfrom\s+)?['"]([^'"\n]+)['"]/.exec(head);
  if (!match || /[\s]/.test(match[1]) || match[1].length > 200) return null;
  return { specifier: match[1], length: match[0].length };
}

/** 只认字符串和注释之外的 import / export。打包代码里的 from '...' 文案不算模块。 */
export function specifiersInSource(source) {
  const out = [];
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const current = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (current === '\\') {
        i += 1;
        continue;
      }
      if (current === quote) quote = null;
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    const word = source.startsWith('import', i) ? 'import' : source.startsWith('export', i) ? 'export' : null;
    const boundary = i === 0 || /[^A-Za-z0-9_$]/.test(source[i - 1]);
    if (!word || !boundary || /[A-Za-z0-9_$]/.test(source[i + word.length] ?? '')) continue;
    const read = readSpecifier(source, i);
    if (!read) continue;
    out.push(read.specifier);
    i += read.length - 1;
  }
  return out;
}

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0];
}

function subpathOf(specifier, packageName) {
  if (specifier === packageName) return '.';
  if (specifier.startsWith(`${packageName}/`)) return `./${specifier.slice(packageName.length + 1)}`;
  return null;
}

function resolveRelative(fromFile, specifier, exists) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** 从 Node 入口走出相对 import，收集裸模块说明符。不进入没被引用的 client.js。 */
export function collectExternalSpecifiers(entryFile, fsLike = fs) {
  const exists = (file) => fsLike.existsSync(file);
  const read = (file) => fsLike.readFileSync(file, 'utf8');
  const seen = new Set();
  const external = new Set();
  const queue = [path.resolve(entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !exists(file)) continue;
    seen.add(file);
    for (const spec of specifiersInSource(read(file))) {
      if (spec.startsWith('.')) {
        const next = resolveRelative(file, spec, exists);
        if (next) queue.push(next);
        continue;
      }
      if (!spec.startsWith('node:') && !spec.startsWith('file:')) external.add(spec);
    }
  }
  return [...external].sort();
}

function subpathAvailable(packageDir, subpath, fsLike) {
  const manifestPath = path.join(packageDir, 'package.json');
  if (fsLike.existsSync(manifestPath)) {
    const manifest = JSON.parse(fsLike.readFileSync(manifestPath, 'utf8'));
    const exposed = manifest.exports;
    if (exposed && typeof exposed === 'object' && !Array.isArray(exposed) && subpath in exposed) return true;
  }
  const rel = subpath.slice(2);
  return [rel, `${rel}.js`, `${rel}.mjs`, path.join(rel, 'index.js')]
    .some((candidate) => fsLike.existsSync(path.join(packageDir, candidate)));
}

/** 返回入口引用了、但 shims/node_modules 里还没有的模块说明符。 */
export function missingShimSpecifiers(specifiers, shimRoot, fsLike = fs) {
  const missing = [];
  for (const spec of specifiers) {
    const name = packageNameOf(spec);
    const packageDir = path.join(shimRoot, ...name.split('/'));
    if (!fsLike.existsSync(packageDir)) {
      missing.push(spec);
      continue;
    }
    const subpath = subpathOf(spec, name);
    if (subpath !== '.' && !subpathAvailable(packageDir, subpath, fsLike)) missing.push(spec);
  }
  return missing;
}

function readTarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function parsePaxPath(data) {
  const text = data.toString('utf8');
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length);
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1).replace(/\n$/, '');
    offset += length;
  }
  return null;
}

/** 把 npm 的 .tgz 解到目标目录，只保留 package/ 下面的文件。 */
export function extractNpmPackage(buffer, destDir) {
  const tar = zlib.gunzipSync(buffer);
  fs.mkdirSync(destDir, { recursive: true });
  let offset = 0;
  let pendingPath = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const sizeText = readTarString(header, 124, 12).trim();
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    const type = header[156];
    offset += 512;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const headerName = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;
    if (type === 120 || type === 88) {
      pendingPath = parsePaxPath(data);
      continue;
    }
    if (type !== 0 && type !== 48) continue;
    const rel = shimPathFromTar(headerName);
    if (!rel) continue;
    const out = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function registryMetadata(name, version) {
  const target = version ?? 'latest';
  const response = await fetch(`https://registry.npmjs.org/${name}/${target}`, {
    headers: { accept: 'application/json', 'user-agent': 'aihub-plugin-update' },
  });
  if (!response.ok) {
    throw new Error(`读取 ${name}@${target} 失败：HTTP ${response.status}`);
  }
  const body = await response.json();
  const tarball = body?.dist?.tarball;
  const integrity = body?.dist?.integrity;
  if (typeof body?.version !== 'string' || typeof tarball !== 'string' || typeof integrity !== 'string') {
    throw new Error(`${name}@${target} 的 registry 响应缺少 version 或 dist`);
  }
  return { version: body.version, tarball, integrity };
}

async function updateOne(shimRoot, spec) {
  const dest = path.join(shimRoot, spec.name);
  const current = fs.existsSync(path.join(dest, 'package.json'))
    ? readJson(path.join(dest, 'package.json')).version
    : null;
  const meta = await registryMetadata(spec.name, spec.version);
  if (current === meta.version) {
    console.log(`${spec.name}: 已是 ${meta.version}，跳过`);
    return false;
  }
  const response = await fetch(meta.tarball, { headers: { 'user-agent': 'aihub-plugin-update' } });
  if (!response.ok) throw new Error(`下载 ${spec.name}@${meta.version} 失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!integrityMatches(buffer, meta.integrity)) {
    throw new Error(`${spec.name}@${meta.version} 的压缩包校验失败`);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-plugin-'));
  try {
    extractNpmPackage(buffer, temp);
    const manifestPath = path.join(temp, 'package.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`${spec.name}@${meta.version} 的压缩包里没有 package.json`);
    const manifest = readJson(manifestPath);
    if (manifest.name !== spec.name || manifest.version !== meta.version) {
      throw new Error(`压缩包是 ${manifest.name}@${manifest.version}，与 ${spec.name}@${meta.version} 不符`);
    }
    const entry = path.join(temp, 'lib', 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`${spec.name}@${meta.version} 没有 lib/index.js`);
    const missing = missingShimSpecifiers(collectExternalSpecifiers(entry), shimRoot);
    if (missing.length > 0) {
      throw new Error(
        `${spec.name}@${meta.version} 的 Node 入口引用了还没有桩的模块：\n${missing.map((item) => `- ${item}`).join('\n')}\n未替换 shims。`,
      );
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(temp, dest, { recursive: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`${spec.name}: ${current ?? '（无）'} → ${meta.version}`);
  return true;
}

async function main() {
  const specs = resolveSpecs(process.argv.slice(2));
  const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shimRoot = path.join(relayRoot, 'shims', 'node_modules');
  let replaced = 0;
  const failures = [];
  for (const spec of specs) {
    try {
      if (await updateOne(shimRoot, spec)) replaced += 1;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (replaced > 0) {
    const sync = spawnSync(process.execPath, [path.join(relayRoot, 'scripts', 'sync-deps.mjs'), '--force'], {
      stdio: 'inherit',
    });
    if (sync.status !== 0) failures.push('同步 packages/relay/node_modules 失败');
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
}

const invoked = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
