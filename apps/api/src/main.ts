import "reflect-metadata";
import { isOriginAllowed, parseCorsOrigins } from "./cors-origin";
import { join } from "path";
import { loadEnvFile } from "./load-env";

// Must run before AppModule is imported/instantiated — DatabaseModule's
// factory reads APP_DATABASE_URL at provider-construction time.
loadEnvFile(join(__dirname, "..", ".env"));

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import compression from "compression";
import { AppModule } from "./app.module";
import { checkRuntimeEnv } from "./common/env-validation";
import { installProcessGuards, requestLogging } from "./common/http-logging";

async function bootstrap() {
  installProcessGuards();
  // Refuse to start with missing required settings (a mis-configured deploy used to boot "healthy" and then fail every call).
  const envReport = checkRuntimeEnv(process.env);
  for (const w of envReport.warnings) console.warn(`[config warning] ${w}`);
  if (envReport.errors.length > 0) {
    for (const e of envReport.errors) console.error(`[config error] ${e}`);
    if (process.env.NODE_ENV === "production") {
      console.error("Refusing to start: fix the settings above.");
      process.exit(1);
    }
  }
  const app = await NestFactory.create(AppModule);

  // Render (and Netlify's proxying to it) sits in front of this API as a
  // single reverse-proxy hop, so `req.ip` is the proxy's own address
  // unless Express is told to trust the one hop of X-Forwarded-For it
  // adds — without this, Phase 2 gap-fill item #3's IP allow/denylist
  // would check the platform's own IP on every request, not the tenant's.
  // INestApplication doesn't expose Express's own `.set()`, so this reaches
  // through to the underlying Express instance, same as any Express-only
  // config Nest itself doesn't wrap.
  // TRUST_PROXY_HOPS: how many proxies sit in front (Render alone = 1; Cloudflare in front of Render = 2). Too low makes
  // req.ip a proxy address (breaks IP allow-lists and per-address limits); too high lets a caller spoof X-Forwarded-For.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  app.getHttpAdapter().getInstance().set("trust proxy", Number.isInteger(hops) && hops >= 0 ? hops : 1);
  app.use(requestLogging());

  // Standard security headers (HSTS, no-sniff, frame-deny, etc.) — cheap,
  // framework-agnostic, and there was previously nothing here at all.
  // crossOriginResourcePolicy is relaxed to "cross-origin": the web app now lives on a different origin than this API
  // (Cloudflare Pages vs Render), and <img> tags (platform logo, tenant logos, avatars) load straight from here. helmet's
  // default "same-origin" makes the browser block them. Data endpoints stay protected by auth + the CORS allowlist.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

  // Compress responses (employee lists and exports are large, the text compresses to a fraction): less to send over the
  // slow hop between Render and the browser.
  app.use(compression());

  // Phase 1 shipped this as `app.enableCors()` (wide open, every origin)
  // with a comment promising it would be "locked down... once real auth
  // exists" — Phase 3 built real auth and this was never revisited until
  // now. CORS_ORIGIN is a comma-separated allowlist; unset defaults to
  // the local Vite dev server only, never to "allow everything."
  //
  // Per-company login URLs (aihxm.com/leadhcm/login) are a PATH on this
  // same frontend origin, not a separate tenant subdomain (an earlier
  // version of this used leadhcm.aihxm.com and needed a dynamic
  // origin-validator here for that — dropped once Netlify's wildcard
  // custom domain requirement, a paid plan support has to enable by hand,
  // ruled subdomains out; see LoginPage.tsx's doc comment). So every
  // tenant's login page is served from the exact same origin as
  // everything else, and this plain static allowlist covers it.
  const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

  app.enableCors({
    origin(origin, callback) {
      // No Origin header at all (server-to-server, curl, health checks) —
      // never a browser CORS concern in the first place.
      if (!origin || isOriginAllowed(origin, corsOrigins)) return callback(null, true);
      callback(new Error(`Origin "${origin}" is not allowed`), false);
    },
    // The browser may call this API directly (a static host that cannot proxy /api, such as Cloudflare Pages): let it
    // read the headers screens use for downloads, and remember the permission check so repeat calls skip it.
    exposedHeaders: ["Content-Disposition", "X-Correlation-Id", "X-Payroll-Batch-Reference", "X-Payroll-Excluded-Count"],
    maxAge: 7200,
  });

  // Strip unknown fields and reject bad ones at the edge, before any
  // handler runs. DTOs (CreateCompanyDto etc.) are the single source of
  // truth for what a request body may contain.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  console.log(`AiHxM API listening on http://localhost:${port}`);
}

bootstrap();
