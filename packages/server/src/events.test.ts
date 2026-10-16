import { afterEach, describe, expect, it } from 'vitest';
import type { App } from './app.js';
import { EventHub, formatSseEvent } from './events.js';
import { createTestApp } from './test/helpers.js';

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!predicate(buffer)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for SSE data; got: ${JSON.stringify(buffer)}`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read timeout')), remaining)),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  return buffer;
}

describe('formatSseEvent', () => {
  it('formats named events with JSON data', () => {
    expect(formatSseEvent('job-updated', { a: 1 })).toBe('event: job-updated\ndata: {"a":1}\n\n');
  });
});

describe('GET /api/events', () => {
  it('streams text/event-stream, broadcasts named events and sends heartbeats', async () => {
    app = await createTestApp({ startQueue: false, deps: { heartbeatMs: 30 } });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const controller = new AbortController();
    const res = await fetch(`${address}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
    const reader = res.body!.getReader();

    await readUntil(reader, (t) => t.includes(': connected'));
    expect(app.ctx.events.clientCount).toBe(1);

    app.ctx.events.broadcast('job-updated', { kind: 'analysis', job: { id: 'j1', status: 'queued' } });
    const text = await readUntil(reader, (t) => t.includes('event: job-updated'));
    expect(text).toContain('data: {"kind":"analysis","job":{"id":"j1","status":"queued"}}\n\n');

    const withHeartbeat = await readUntil(reader, (t) => t.includes(': heartbeat'));
    expect(withHeartbeat).toContain(': heartbeat\n\n');

    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(app.ctx.events.clientCount).toBe(0);
  });

  it('EventHub drops clients on close', () => {
    const hub = new EventHub(0);
    expect(hub.clientCount).toBe(0);
    hub.close();
    expect(hub.clientCount).toBe(0);
  });
});
