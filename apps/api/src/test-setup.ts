/**
 * Runs before every test file (see jest.config.js's `setupFiles`) so
 * apps/api/.env is loaded into process.env the same way main.ts and
 * migrate.ts load it — tests talk to the same local Postgres/Redis every
 * other verification step in this project uses, never a mocked database.
 * RLS is the whole point of this codebase's isolation guarantees; mocking
 * `pg` would test nothing about it.
 */
import { join } from "path";
import { loadEnvFile } from "./load-env";

loadEnvFile(join(__dirname, "..", ".env"));
