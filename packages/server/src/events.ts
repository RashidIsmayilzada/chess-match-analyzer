/**
 * Server-sent events hub. GET /api/events keeps the response open; `broadcast` writes a
 * named event to every connected client; a comment line is sent every 15 s as a heartbeat.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

export type EventName = 'import-progress' | 'analysis-progress' | 'job-updated';

export const HEARTBEAT_INTERVAL_MS = 15_000;

export function formatSseEvent(event: string, data: unknown): string {
  const payload = JSON.stringify(data);
  // A payload containing newlines must be split across several data: lines.
  const dataLines = payload
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
}

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly heartbeatMs: number = HEARTBEAT_INTERVAL_MS) {}

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach a raw response as an SSE client. Headers must not have been sent yet. */
  add(res: ServerResponse): void {
    if (this.closed) {
      res.statusCode = 503;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders?.();
    res.write(`retry: 3000\n: connected\n\n`);
    this.clients.add(res);
    const remove = () => {
      this.clients.delete(res);
    };
    res.on('close', remove);
    res.on('error', remove);
    this.ensureHeartbeat();
  }

  broadcast(event: EventName, data: unknown): void {
    if (this.clients.size === 0) return;
    this.writeAll(formatSseEvent(event, data));
  }

  /** End every client connection and stop the heartbeat. */
  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      if (this.clients.size === 0) {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        return;
      }
      this.writeAll(': heartbeat\n\n');
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  private writeAll(frame: string): void {
    for (const res of this.clients) {
      if (res.destroyed || res.writableEnded) {
        this.clients.delete(res);
        continue;
      }
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

export function registerEventsRoute(app: FastifyInstance, hub: EventHub): void {
  app.get('/api/events', (_request, reply) => {
    // Take over the raw response: the hub keeps it open and drops it on 'close'.
    reply.hijack();
    hub.add(reply.raw);
  });
}
