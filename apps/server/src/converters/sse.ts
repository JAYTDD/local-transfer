export interface SseEvent {
  event: string | null;
  data: string;
}

export function createSseParser(): {
  push(text: string): SseEvent[];
  flush(): SseEvent[];
} {
  let buffer = '';
  let event: string | null = null;
  let dataLines: string[] = [];
  let output: SseEvent[] = [];

  function dispatch(): void {
    if (dataLines.length > 0) output.push({ event, data: dataLines.join('\n') });
    event = null;
    dataLines = [];
  }

  function handleLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const index = line.indexOf(':');
    const field = index === -1 ? line : line.slice(0, index);
    let value = index === -1 ? '' : line.slice(index + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') dataLines.push(value);
  }

  function take(): SseEvent[] {
    const result = output;
    output = [];
    return result;
  }

  return {
    push(text: string): SseEvent[] {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
      return take();
    },
    flush(): SseEvent[] {
      if (buffer) {
        handleLine(buffer);
        buffer = '';
      }
      dispatch();
      return take();
    },
  };
}

export function dataEvent(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}
