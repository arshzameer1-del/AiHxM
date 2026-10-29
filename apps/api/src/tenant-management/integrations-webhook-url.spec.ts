import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";

const CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "webhook-url-spec" };

/** S1: a webhook address is called by the server itself, so addresses on the server's own network are refused at save time. */
describe("webhook address validation", () => {
  let pool: Pool;
  let db: DatabaseService;
  let service: IntegrationsService;
  let companyId: string;
  const saved = process.env.OUTBOUND_ALLOW_PRIVATE;

  beforeAll(async () => {
    process.env.OUTBOUND_ALLOW_PRIVATE = "false";
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    service = new IntegrationsService(db, new AuditService());
    companyId = await db.withClaims(CLAIMS, async (c) => {
      const s = Date.now();
      return (await c.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`Webhook Url Spec ${s}`, `webhook-url-spec-${s}`])).rows[0].id as string;
    });
  });
  afterAll(async () => {
    process.env.OUTBOUND_ALLOW_PRIVATE = saved;
    await db.withClaims(CLAIMS, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it.each(["http://hooks.example.com/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data/", "https://localhost/x", "https://10.0.0.5/x", "https://[::1]/x"])(
    "rejects %s", async (url) => {
      await expect(service.configure(CLAIMS, companyId, "webhook", { enabled: true, config: { url, signingSecret: "s" } })).rejects.toBeInstanceOf(BadRequestException);
    });

  it("accepts a public https address", async () => {
    const r = await service.configure(CLAIMS, companyId, "webhook", { enabled: true, config: { url: "https://8.8.8.8/hook", signingSecret: "s" } });
    expect(r.enabled).toBe(true);
  });
});
