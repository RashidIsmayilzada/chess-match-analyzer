/**
 * Small HTTP helpers: typed errors, zod validation and the shared error handler.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, details);
}

/** Validate `input` with a zod schema; throws a 400 HttpError with the issues on failure. */
export function validate<T>(schema: ZodType<T>, input: unknown, what = 'request'): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  throw badRequest(`Invalid ${what}: ${summary}`, issues);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.message, details: error.details ?? undefined });
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    const rawStatus = (err as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
    if (statusCode >= 500) request.log.error(err);
    void reply.code(statusCode).send({ error: err.message || 'Internal server error' });
  });
}
