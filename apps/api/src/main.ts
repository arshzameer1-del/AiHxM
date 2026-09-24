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

  // Standard security headers (HSTS, no-sniff, frame-deny, etc.) — cheap,
  // framework-agnostic, and there was previously nothing here at all.
  app.use(helmet());

  // Phase 1 shipped this as `app.enableCors()` (wide open, every origin)
  // with a comment promising it would be "locked down... once real auth
  // exists" — Phase 3 built real auth and this was never revisited until
  // now. CORS_ORIGIN is a comma-separated allowlist; unset defaults to
  // the local Vite dev server only, never to "allow everything."
  const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins });

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
