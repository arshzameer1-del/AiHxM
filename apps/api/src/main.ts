import "reflect-metadata";
import { join } from "path";
import { loadEnvFile } from "./load-env";

// Must run before AppModule is imported/instantiated — DatabaseModule's
// factory reads APP_DATABASE_URL at provider-construction time.
loadEnvFile(join(__dirname, "..", ".env"));

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Render (and Netlify's proxying to it) sits in front of this API as a
  // single reverse-proxy hop, so `req.ip` is the proxy's own address
  // unless Express is told to trust the one hop of X-Forwarded-For it
  // adds — without this, Phase 2 gap-fill item #3's IP allow/denylist
  // would check the platform's own IP on every request, not the tenant's.
  // INestApplication doesn't expose Express's own `.set()`, so this reaches
  // through to the underlying Express instance, same as any Express-only
  // config Nest itself doesn't wrap.
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // Standard security headers (HSTS, no-sniff, frame-deny, etc.) — cheap,
  // framework-agnostic, and there was previously nothing here at all.
  app.use(helmet());

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
  const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin(origin, callback) {
      // No Origin header at all (server-to-server, curl, health checks) —
      // never a browser CORS concern in the first place.
      if (!origin || corsOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin "${origin}" is not allowed`), false);
    },
  });

  // Strip unknown fields and reject bad ones at the edge, before any
  // handler runs. DTOs (CreateCompanyDto etc.) are the single source of
  // truth for what a request body may contain.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  console.log(`AIHXM API listening on http://localhost:${port}`);
}

bootstrap();
