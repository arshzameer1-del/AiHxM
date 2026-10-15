import { Pool } from "pg";
import { randomUUID } from "crypto";

/** Gap Register SEC-09 -- migration 0124. Runs as the table owner. */
describe("user_sessions foreign key (0124)", () => {
  let owner: Pool;
  beforeAll(() => {
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await owner.end();
  });

  const mkUser = async () =>
    (await owner.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`fk-${randomUUID()}@example.com`])).rows[0].id as string;
  const mkSession = (userId: string) =>
    owner.query("INSERT INTO user_sessions (user_account_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id", [userId]);

  it("rejects a session for a user that does not exist", async () => {
    await expect(mkSession(randomUUID())).rejects.toThrow(/user_sessions_user_account_id_fkey/);
  });

  it("deleting the user account removes its sessions", async () => {
    const userId = await mkUser();
    const s = (await mkSession(userId)).rows[0].id;
    await owner.query("DELETE FROM user_accounts WHERE id = $1", [userId]);
    const left = await owner.query("SELECT 1 FROM user_sessions WHERE id = $1", [s]);
    expect(left.rowCount).toBe(0);
  });
});
