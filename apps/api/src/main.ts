import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Phase 1: permissive CORS for local dev only. Locked down to known
  // tenant/admin origins once real auth (Phase 3) exists.
  app.enableCors();

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  console.log(`BoostFactor API listening on http://localhost:${port}`);
}

bootstrap();
