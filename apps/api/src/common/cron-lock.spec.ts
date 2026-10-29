import { Pool } from "pg";
import { ExclusiveCron, registerCronLockPool } from "./cron-lock";

class Job {
  runs = 0;
  @ExclusiveCron("spec.job")
  async tick(hold: Promise<void> = Promise.resolve()) {
    this.runs += 1;
    await hold;
  }
}

describe("ExclusiveCron", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    registerCronLockPool(pool);
  });
  afterAll(async () => {
    registerCronLockPool(null);
    await pool.end();
  });

  it("runs without a registered pool", async () => {
    registerCronLockPool(null);
    const j = new Job();
    await j.tick();
    expect(j.runs).toBe(1);
    registerCronLockPool(pool);
  });

  it("skips a second run while the first still holds the lock, then runs again", async () => {
    const a = new Job();
    const b = new Job();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = a.tick(hold);
    await new Promise((r) => setTimeout(r, 150));
    await b.tick();
    expect(b.runs).toBe(0);
    release();
    await first;
    await b.tick();
    expect(b.runs).toBe(1);
  });
});
