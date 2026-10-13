import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectExternalSpecifiers,
  extractNpmPackage,
  integrityMatches,
  missingShimSpecifiers,
  resolveSpecs,
  shimPathFromTar,
} from '../scripts/update-plugins.mjs';

test('不带参数时更新全部三个插件，指定版本和未知包会被识别', () => {
  assert.deepEqual(resolveSpecs([]).map((spec) => spec.name), [
    'dsh-connect-trae',
    'dsh-workbuddy-connect',
    'dsh-qoder-connect',
  ]);
  assert.deepEqual(resolveSpecs(['dsh-connect-trae@3.4.2']), [
    { name: 'dsh-connect-trae', version: '3.4.2' },
  ]);
  assert.throws(() => resolveSpecs(['left-pad']), /不在允许更新的插件列表里/);
  assert.throws(() => resolveSpecs(['dsh-connect-trae', 'dsh-connect-trae@1.0.0']), /重复指定了插件/);
});

test('按 npm integrity 校验压缩包字节', () => {
  const body = Buffer.from('plugin-tarball');
  const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  assert.equal(integrityMatches(body, integrity), true);
  assert.equal(integrityMatches(body, 'sha512-aaaa'), false);
  assert.equal(integrityMatches(body, 'not-an-integrity'), false);
});

test('只收下 package/ 里的文件', () => {
  assert.equal(shimPathFromTar('package/lib/index.js'), 'lib/index.js');
  assert.equal(shimPathFromTar('package/package.json'), 'package.json');
  assert.equal(shimPathFromTar('package/'), null);
  assert.equal(shimPathFromTar('package/node_modules/left-pad/index.js'), null);
  assert.equal(shimPathFromTar('package/../secrets.txt'), null);
});

test('入口扫描跟着相对 import 走，不把没引用的 client.js 算进去', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-plugin-scan-'));
  const lib = path.join(root, 'lib');
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, 'index.js'), [
    "const sql = `select value from ItemTable where key='secret' limit 1`;",
    "const note = 'from the request never arrived';",
    "import { chunk } from './chunk.js';",
    "import { z } from '@deepseek-ai/schemastery';",
    "import 'react';",
    'export const chunkName = chunk;',
  ].join('\n'));
  fs.writeFileSync(path.join(lib, 'chunk.js'), "export { api } from '@earendil-works/pi-ai/api/openai-completions.lazy';\n");
  fs.writeFileSync(path.join(lib, 'client.js'), "import 'react-dom';\n");

  assert.deepEqual(collectExternalSpecifiers(path.join(lib, 'index.js')), [
    '@deepseek-ai/schemastery',
    '@earendil-works/pi-ai/api/openai-completions.lazy',
    'react',
  ]);

  const shims = path.join(root, 'shims');
  fs.mkdirSync(path.join(shims, '@deepseek-ai', 'schemastery'), { recursive: true });
  fs.writeFileSync(path.join(shims, '@deepseek-ai', 'schemastery', 'package.json'), '{"name":"@deepseek-ai/schemastery"}\n');
  fs.mkdirSync(path.join(shims, '@earendil-works', 'pi-ai', 'api'), { recursive: true });
  fs.writeFileSync(path.join(shims, '@earendil-works', 'pi-ai', 'package.json'), JSON.stringify({
    exports: { '.': './index.js' },
  }));
  const missing = missingShimSpecifiers(collectExternalSpecifiers(path.join(lib, 'index.js')), shims);
  assert.deepEqual(missing, [
    '@earendil-works/pi-ai/api/openai-completions.lazy',
    'react',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000644\0', 100);
  header.write('0001750\0', 108);
  header.write('0001750\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(`${'0'.repeat(11)}\0`, 136);
  header.write('        ', 148);
  header[156] = 48;
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

test('解压 npm 包时去掉 package/ 前缀', () => {
  const payload = Buffer.from('{"name":"dsh-connect-trae"}\n');
  const blocks = Buffer.concat([
    tarHeader('package/package.json', payload.length),
    payload,
    Buffer.alloc(512 - (payload.length % 512 || 512)),
    Buffer.alloc(1024),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-plugin-tar-'));
  extractNpmPackage(zlib.gzipSync(blocks), root);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), payload.toString());
  fs.rmSync(root, { recursive: true, force: true });
});
