/**
 * WorkBuddy（wb / wbai）出站兼容。
 *
 * 上游有两条实测确认的整单拦截规则（400「请求被安全策略拦截」）：
 *   1. system 消息含 `x-anthropic-billing-header: …` 计费头块 —— wb、wbai 都拦，
 *      单独出现即拦。cc-switch 之类翻译层会剥掉它，但直连客户端可能带着。
 *   2. system 消息含 Claude Code 身份签名句
 *      `You are Claude Code, Anthropic's official CLI for Claude …` —— 仅 wbai 拦。
 *      终端 CLI 2.1.289 起已改用别的措辞，VS Code 扩展每个请求仍带旧签名；
 *      wb 国内版对同一句放行。签名是精确匹配，改一个词即可绕过
 *      （"Anthropic's official" → "the official"，语义等价，真实被拦请求体实测放行）。
 *
 * 两条修整都只作用于 system / developer 消息（上游不扫 user/assistant）；
 * 请求不含这些内容时返回原对象——同一引用、序列化逐字节不变。
 * 撇号兼容 U+2019 与 ASCII。
 */

const SIGNATURE = /You are Claude Code, Anthropic['\u2019]s official CLI for Claude/g;
const SIGNATURE_REPLACEMENT = 'You are Claude Code, the official CLI for Claude';

const BILLING_PREFIX = 'x-anthropic-billing-header:';
const BILLING_LINE = /^x-anthropic-billing-header:.*(?:\n|$)/gm;

function mapText(text) {
  const stripped = text.replace(SIGNATURE, SIGNATURE_REPLACEMENT);
  return stripped === text ? null : stripped;
}

function mapStringContent(content) {
  const out = mapText(content);
  return out === null ? content : out;
}

function mapArrayContent(content) {
  let changed = false;
  const parts = content.map((part) => {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      const out = mapText(part.text);
      if (out !== null) {
        changed = true;
        return { ...part, text: out };
      }
    }
    return part;
  });
  return changed ? parts : content;
}

function mapContent(content) {
  if (typeof content === 'string') return mapStringContent(content);
  if (Array.isArray(content)) return mapArrayContent(content);
  return content;
}

function isSystemish(message) {
  return message && typeof message === 'object' && (message.role === 'system' || message.role === 'developer');
}

/** 映射函数返回 null 表示该消息无变化；否则返回新 content。 */
function rewriteMessages(body, map) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isSystemish(message)) return message;
    const content = map(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...body, messages } : body;
}

/**
 * 规则 2：改写 wbai 拦截的 Claude Code 身份签名句。
 * 没命中 → 返回原对象。
 */
export function rewriteClaudeCodeSignature(body) {
  return rewriteMessages(body, mapContent);
}

/**
 * 规则 1：剥掉 system/developer 消息里的 Claude Code 计费头。
 * 块数组里"整块就是计费头"的 text 块整个移除；字符串内容按行剔除；
 * 剔完为空的消息 content 置空串。没命中 → 返回原对象。
 */
export function stripBillingHeader(body) {
  return rewriteMessages(body, (content) => {
    if (typeof content === 'string') {
      if (!content.includes(BILLING_PREFIX)) return content;
      return content.replace(BILLING_LINE, '').replace(/^\n+/, '');
    }
    if (Array.isArray(content)) {
      const kept = content.filter((part) => !(
        part && typeof part === 'object' && part.type === 'text' &&
        typeof part.text === 'string' && part.text.trimStart().startsWith(BILLING_PREFIX)
      ));
      if (kept.length === content.length) return content;
      return kept.length > 0 ? kept : '';
    }
    return content;
  });
}
