/**
 * Zero-dependency `.env` loader (Decision #2's minimalism applied here
 * too — no reason to pull in `dotenv` for something this small). Shared
 * by the app entrypoint (main.ts) and the migration runner
 * (database/migrate.ts) so both pick up apps/api/.env the same way.
 * Never overrides a variable the process already has set — real
 * deployments (CI, hosting) set env vars directly and should win.
 */
import { readFileSync, existsSync } from "fs";

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;

  const contents = readFileSync(path, "utf-8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
