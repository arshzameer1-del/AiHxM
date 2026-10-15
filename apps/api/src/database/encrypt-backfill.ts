/**
 * One-off / resumable operations script for Gap Register SEC-02.
 *
 *   npm run encrypt-backfill --workspace=@ai-hxm/api            # every tenant
 *   npm run encrypt-backfill --workspace=@ai-hxm/api -- <companyId>
 *   npm run encrypt-backfill --workspace=@ai-hxm/api -- --dry-run
 *
 * Needs the same env as the API (APP_DATABASE_URL, FIELD_ENCRYPTION_KEY).
 * Safe to stop and re-run at any time. Prints rows still holding plaintext
 * per tenant; the job is finished when every number is 0.
 */
import { join } from "path";
import { loadEnvFile } from "../load-env";
loadEnvFile(join(__dirname, "..", "..", ".env"));

import { Pool } from "pg";
import { DatabaseService } from "./database.service";
import { EncryptionBackfillService } from "../crypto/encryption-backfill.service";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const only = args.find((a) => !a.startsWith("--"));
  const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
  const db = new DatabaseService(pool);
  const svc = new EncryptionBackfillService();
  const service = { is_platform_admin: true, company_id: null, sub: "encrypt-backfill-script" };

  const companies: string[] = only
    ? [only]
    : (await db.withClaims(service, (c) => c.query("SELECT id FROM companies ORDER BY created_at"))).rows.map((r) => r.id);

  let totalRemaining = 0;
  for (const companyId of companies) {
    const claims = { ...service, company_id: companyId };
    if (dryRun) {
      const pending = await db.withClaims(claims, async (c) => {
        const { fieldCrypto } = await import("../crypto/field-crypto");
        await fieldCrypto.warm(c, companyId);
        return svc.pendingCounts(c, companyId);
      });
      console.log(companyId, "pending:", JSON.stringify(pending));
      totalRemaining += Object.values(pending).reduce((a, b) => a + b, 0);
      continue;
    }
    // one transaction per batch keeps locks short; runToCompletion's loop is
    // done outside so each batch commits independently (resumable).
    let remaining = 1;
    const converted: Record<string, number> = {};
    while (remaining > 0) {
      const res = await db.withClaims(claims, async (c) => {
        const batch = await svc.runBatch(c, companyId, 200);
        return { batch, remaining: Object.values(await svc.pendingCounts(c, companyId)).reduce((a, b) => a + b, 0) };
      });
      for (const [t, n] of Object.entries(res.batch)) converted[t] = (converted[t] ?? 0) + n;
      remaining = res.remaining;
      if (Object.values(res.batch).every((n) => n === 0)) break;
    }
    totalRemaining += remaining;
    console.log(companyId, "converted:", JSON.stringify(converted), "remaining:", remaining);
  }
  await pool.end();
  console.log(totalRemaining === 0 ? "DONE: no plaintext sensitive values remain." : `INCOMPLETE: ${totalRemaining} rows still hold plaintext.`);
  process.exit(totalRemaining === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
