import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteClaudeCodeSignature, stripBillingHeader } from '../src/workbuddy-compat.mjs';

const BILLING = 'x-anthropic-billing-header: cc_version=2.1.289.81d; cc_entrypoint=claude-vscode;';
const SIG_ASCII = "You are Claude Code, Anthropic's official CLI for Claude.";
// VS Code 扩展实际发送的变体：带 SDK 后缀 + U+2019 撇号
const SIG_VSCODE = 'You are Claude Code, Anthropic\u2019s official CLI for Claude, running within the Claude Agent SDK.';

test('strip：不含计费头 → 返回原引用，逐字节不变', () => {
  const body = { messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }] };
  assert.equal(stripBillingHeader(body), body);
});

test('strip：块数组里整块计费头被移除，其余块保持原引用', () => {
  const billing = { type: 'text', text: BILLING };
  const identity = { type: 'text', text: SIG_VSCODE, cache_control: { type: 'ephemeral' } };
  const body = { messages: [{ role: 'system', content: [billing, identity] }] };
  const out = stripBillingHeader(body);
  assert.notEqual(out, body);
  assert.equal(out.messages[0].content.length, 1);
  assert.equal(out.messages[0].content[0], identity, '未命中的块保持原引用');
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' });
});

test('strip：字符串内容按行剔除计费头，其余保留', () => {
  const body = { messages: [{ role: 'system', content: `${BILLING}\nYou are a helpful assistant.` }] };
  const out = stripBillingHeader(body);
  assert.equal(out.messages[0].content, 'You are a helpful assistant.');
});

test('strip：整条消息只有计费头 → content 置空串', () => {
  const body = { messages: [{ role: 'system', content: [{ type: 'text', text: BILLING }] }] };
  const out = stripBillingHeader(body);
  assert.equal(out.messages[0].content, '');
  // 字符串形态同理
  const body2 = { messages: [{ role: 'system', content: BILLING }] };
  assert.equal(stripBillingHeader(body2).messages[0].content, '');
});

test('strip：billing 只在 user 消息 → 不动，返回原引用', () => {
  const body = { messages: [{ role: 'user', content: BILLING }] };
  assert.equal(stripBillingHeader(body), body);
});

test('strip：developer 消息同样处理', () => {
  const body = { messages: [{ role: 'developer', content: `${BILLING}\ncore instructions` }] };
  assert.equal(stripBillingHeader(body).messages[0].content, 'core instructions');
});

test('签名：不含签名 → 返回原引用', () => {
  const body = { messages: [{ role: 'system', content: 'You are a Claude agent, built on Anthropic\u2019s Claude Agent SDK.' }] };
  assert.equal(rewriteClaudeCodeSignature(body), body);
});

test('签名：CLI 旧签名句（system 字符串）→ 只改这一句，user 不碰', () => {
  const body = { messages: [{ role: 'system', content: SIG_ASCII }, { role: 'user', content: SIG_ASCII }] };
  const out = rewriteClaudeCodeSignature(body);
  assert.notEqual(out, body);
  assert.equal(out.messages[0].content, 'You are Claude Code, the official CLI for Claude.');
  assert.equal(out.messages[1].content, SIG_ASCII, 'user 消息原样（上游不扫）');
});

test('签名：VS Code 变体（U+2019 + SDK 后缀）→ 命中', () => {
  const body = { messages: [{ role: 'system', content: SIG_VSCODE }] };
  assert.equal(
    rewriteClaudeCodeSignature(body).messages[0].content,
    'You are Claude Code, the official CLI for Claude, running within the Claude Agent SDK.',
  );
});

test('签名：块数组 → 只改命中的 text 块', () => {
  const body = { messages: [{ role: 'system', content: [{ type: 'text', text: 'prefix' }, { type: 'text', text: SIG_ASCII }] }] };
  const out = rewriteClaudeCodeSignature(body);
  assert.equal(out.messages[0].content[0].text, 'prefix');
  assert.equal(out.messages[0].content[1].text, 'You are Claude Code, the official CLI for Claude.');
});

test('签名 + 计费头同时存在：两个函数可组合，互不干扰', () => {
  const body = { messages: [{ role: 'system', content: [{ type: 'text', text: BILLING }, { type: 'text', text: SIG_VSCODE }] }] };
  const out = rewriteClaudeCodeSignature(stripBillingHeader(body));
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'You are Claude Code, the official CLI for Claude, running within the Claude Agent SDK.' }]);
});

test('非对象 / 无 messages：原样返回不抛错', () => {
  for (const fn of [rewriteClaudeCodeSignature, stripBillingHeader]) {
    assert.equal(fn(null), null);
    const empty = {};
    assert.equal(fn(empty), empty);
    const noMessages = { messages: 'nope' };
    assert.equal(fn(noMessages), noMessages);
  }
});
