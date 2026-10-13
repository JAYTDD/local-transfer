/**
 * 把 Anthropic Messages 请求收成 OpenAI chat completions 请求。
 * 只接受文本块；图片等内容仍交给后面的渠道转换去拒绝。
 */

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text') {
        return String((part as { text?: unknown }).text ?? '');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function anthropicMessagesToChat(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new Error('messages body must be an object');
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.model !== 'string' || raw.model === '') throw new Error('model is required');
  const messages: Array<Record<string, unknown>> = [];
  const system = textOf(raw.system);
  if (system) messages.push({ role: 'system', content: system });
  if (!Array.isArray(raw.messages)) throw new Error('messages is required');
  for (const message of raw.messages) {
    if (typeof message !== 'object' || message === null) continue;
    const role = (message as { role?: unknown }).role;
    if (role !== 'user' && role !== 'assistant') continue;
    messages.push({ role, content: textOf((message as { content?: unknown }).content) });
  }
  if (messages.length === 0) throw new Error('messages is required');
  return {
    model: raw.model,
    messages,
    ...(typeof raw.max_tokens === 'number' ? { max_tokens: raw.max_tokens } : {}),
    ...(raw.stream === true ? { stream: true } : {}),
    ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
  };
}
