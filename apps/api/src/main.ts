import "reflect-metadata";
import { join } from "path";
import { loadEnvFile } from "./load-env";

// Must run before AppModule is imported/instantiated — DatabaseModule's
// factory reads APP_DATABASE_URL at provider-construction time.
loadEnvFile(join(__dirname, "..", ".env"));

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Phase 1: permissive CORS for local dev only. Locked down to known
  // tenant/admin origins once real auth (Phase 3) exists.
  app.enableCors();

  // Strip unknown fields and reject bad ones at the edge, before any
  // handler runs. DTOs (CreateCompanyDto etc.) are the single source of
  // truth for what a request body may contain.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  console.log(`BoostFactor API listening on http://localhost:${port}`);
}

bootstrap();
