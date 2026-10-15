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
};

const storage = new AsyncLocalStorage<RequestContext>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
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
    storage.run({ correlationId, ipAddress: req.ip ?? null, sourceChannel: "api" }, next);
  }
}
