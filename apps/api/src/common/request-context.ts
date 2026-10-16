import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { Injectable, NestMiddleware } from "@nestjs/common";

/**
 * Gap Register SEC-06 / register A2 rule 9 — "every write carries a
 * correlation ID into audit and events". One store per HTTP request (and,
 * via `runWithContext`, per background job / scheduled run), read by
 * AuditService and the domain-event outbox so callers never have to thread
 * a correlation id through their method signatures.
 */
export type RequestContext = {
  correlationId: string;
  ipAddress?: string | null;
  sourceChannel: "api" | "ui" | "import" | "job" | "integration" | "system";
  /**
   * Answers to "is this module on / does this user hold this permission" already looked up during THIS http request.
   * It lives and dies with the request (a new one is made for the next request), so an authorization change is seen on the
   * very next request, and it is absent for jobs, scripts and direct service calls, which always ask the database.
   */
  gateMemo?: Map<string, Promise<boolean>>;
};

const storage = new AsyncLocalStorage<RequestContext>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
}

/**
 * Asks `lookup` at most once per http request for the same key, even when many callers ask at the same moment (the Configuration
 * Center asks for the same permission once per card). Outside a request it simply calls `lookup`.
 */
export function memoizeForRequest(key: string, lookup: () => Promise<boolean>): Promise<boolean> {
  const memo = storage.getStore()?.gateMemo;
  if (!memo) return lookup();
  const hit = memo.get(key);
  if (hit) return hit;
  const pending = lookup().catch((err) => {
    memo.delete(key);
    throw err;
  });
  memo.set(key, pending);
  return pending;
}

export function runWithContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
  return storage.run(
    { correlationId: ctx.correlationId ?? randomUUID(), ipAddress: ctx.ipAddress ?? null, sourceChannel: ctx.sourceChannel ?? "system" },
    fn
  );
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Honour a well-formed inbound X-Correlation-Id (lets a caller or the
    // frontend tie several calls together); otherwise mint one. Never trust
    // a malformed value — it ends up in a uuid column.
    const inbound = req.header("x-correlation-id");
    const correlationId = inbound && UUID_RE.test(inbound) ? inbound : randomUUID();
    res.setHeader("X-Correlation-Id", correlationId);
    storage.run({ correlationId, ipAddress: req.ip ?? null, sourceChannel: "api", gateMemo: new Map() }, next);
  }
}
