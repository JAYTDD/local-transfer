import test from 'node:test';
import assert from 'node:assert/strict';

// wbai 修复的回归守卫：store 必须拿到原插件同款的 at-rest key resolver。
// 漏掉 keyProvider 时 store 自建的默认 resolver discovery 落回 "none"，
// 永远不去找 app 的 Electron 二进制；WorkBuddy 5.6 起凭据加密，
// 解不开就 not_signed_in（wbai 曾经的故障，见 PROJECT.md 坑 12）。

test('两个变体的 store 都拿到 keyProvider，且 discovery 随平台启用', async () => {
  const { createWorkBuddyProvider } = await import('../src/providers/workbuddy.mjs');
  const expected =
    process.platform === 'darwin'
      ? 'macos-workbuddy'
      : process.platform === 'win32'
        ? 'windows-workbuddy'
        : 'none';
  for (const variantId of ['cn', 'global']) {
    const provider = await createWorkBuddyProvider(variantId);
    const kp = provider.store.keyProvider;
    assert.notEqual(kp, undefined, `${variantId} 的 store 没有 keyProvider`);
    // 原插件工厂产物（WorkBuddyAtRestKeyProvider）的接口面
    assert.equal(typeof kp.protectorKeyFor, 'function', `${variantId}: 缺 protectorKeyFor`);
    assert.equal(typeof kp.resolveElectronPath, 'function', `${variantId}: 缺 resolveElectronPath`);
    assert.equal(typeof kp.helperPath, 'function', `${variantId}: 缺 helperPath`);
    // 关键回归点：discovery 必须是插件 electronDiscoveryFor() 的平台值，不能是 "none"
    assert.equal(kp.discovery, expected, `${variantId}: discovery 未启用，加密凭据将解不开`);
    await provider.close();
  }
});

test('每个变体独立的 keyProvider 实例（各自缓存 key，互不串）', async () => {
  const { createWorkBuddyProvider } = await import('../src/providers/workbuddy.mjs');
  const cn = await createWorkBuddyProvider('cn');
  const ai = await createWorkBuddyProvider('global');
  assert.notEqual(cn.store.keyProvider, ai.store.keyProvider);
  await cn.close();
  await ai.close();
});

// 显式路径失效的回归守卫：插件对显式路径"只信不退回"，变量指向不存在的
// 文件会让整条通道直接失效（CN 客户端升级换目录后踩过，见 dropStaleElectronBin）。
test('指向不存在文件的 ELECTRON_BIN 被丢弃，让插件自己的发现逻辑接手', async () => {
  const { dropStaleElectronBin } = await import('../src/providers/workbuddy.mjs');
  const VAR = 'WORKBUDDY_ELECTRON_BIN_TEST';
  const original = process.env[VAR];
  try {
    // 未设置：不动，不报
    delete process.env[VAR];
    assert.equal(dropStaleElectronBin(VAR), undefined);
    assert.equal(process.env[VAR], undefined);

    // 路径有效：原样保留（当前文件系统里确定存在的文件）
    const real = new URL('../package.json', import.meta.url).pathname;
    process.env[VAR] = process.platform === 'win32' ? real.replace(/^\//, '') : real;
    assert.equal(dropStaleElectronBin(VAR), undefined);
    assert.notEqual(process.env[VAR], undefined, '有效路径不该被丢掉');

    // 路径失效（客户端换安装目录的典型情形）：丢掉变量并返回旧值
    const stale = process.platform === 'win32' ? 'D:\\gone\\WorkBuddy.exe' : '/gone/WorkBuddy';
    process.env[VAR] = stale;
    assert.equal(dropStaleElectronBin(VAR), stale);
    assert.equal(process.env[VAR], undefined, '失效路径必须被丢掉，否则通道永久不可用');
  } finally {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  }
});
