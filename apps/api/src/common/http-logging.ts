import type { NextFunction, Request, Response } from "express";
import { currentCorrelationId } from "./request-context";

/**
 * One JSON line per finished request (method, path without query string, status, milliseconds, correlation id), so logs
 * can be searched and a user's error report can be matched with the X-Correlation-Id header they were given.
 * On by default in production; LOG_REQUESTS=on|off overrides.
 */
export function requestLogging(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.LOG_REQUESTS ?? (env.NODE_ENV === "production" ? "on" : "off");
  if (mode !== "on") return (_req: Request, _res: Response, next: NextFunction) => next();
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      if (req.path === "/health" || req.path === "/health/ready") return;
      const line = JSON.stringify({
        t: new Date().toISOString(),
        level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        msg: "request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        correlationId: currentCorrelationId() ?? res.getHeader("X-Correlation-Id") ?? null,
      });
      process.stdout.write(line + "\n");
    });
    next();
  };
}

/** Process-level safety net: log and keep serving instead of dying on a stray rejected promise. */
export function installProcessGuards(log: (msg: string, extra?: unknown) => void = defaultLog): void {
  process.on("unhandledRejection", (reason) => log("unhandledRejection", reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason: String(reason) }));
  process.on("uncaughtException", (err) => {
    log("uncaughtException", { message: err.message, stack: err.stack });
    // A connection error from the database driver is survivable (the pool reconnects). Anything else leaves the process in an
    // unknown state, so exit and let the platform restart it.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    const survivable = /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|57P0[1-3]|08\w+)$/.test(String(code));
    if (!survivable) setTimeout(() => process.exit(1), 100).unref();
  });
}

function defaultLog(msg: string, extra?: unknown) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: "error", msg, ...(extra as object) }) + "\n");
}
