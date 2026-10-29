import { checkRuntimeEnv } from "./env-validation";

describe("checkRuntimeEnv", () => {
  it("accepts a complete development setup", () => {
    const r = checkRuntimeEnv({ APP_DATABASE_URL: "postgres://x", JWT_SECRET: "dev" } as NodeJS.ProcessEnv);
    expect(r.errors).toEqual([]);
  });
  it("reports missing database url and secret", () => {
    const r = checkRuntimeEnv({} as NodeJS.ProcessEnv);
    expect(r.errors.join(" ")).toMatch(/APP_DATABASE_URL/);
    expect(r.errors.join(" ")).toMatch(/JWT_SECRET/);
  });
  it("is strict in production", () => {
    const r = checkRuntimeEnv({ NODE_ENV: "production", APP_DATABASE_URL: "postgres://x", JWT_SECRET: "short" } as NodeJS.ProcessEnv);
    expect(r.errors.join(" ")).toMatch(/shorter than 32/);
    expect(r.errors.join(" ")).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(r.errors.join(" ")).toMatch(/CORS_ORIGIN/);
    expect(r.warnings.join(" ")).toMatch(/SMTP_HOST/);
  });
  it("passes a full production setup", () => {
    const r = checkRuntimeEnv({
      NODE_ENV: "production", APP_DATABASE_URL: "x", JWT_SECRET: "x".repeat(40), MFA_ENCRYPTION_KEY: "a", FIELD_ENCRYPTION_KEY: "b",
      CORS_ORIGIN: "https://app.aihxm.com", APP_BASE_URL: "https://app.aihxm.com", SMTP_HOST: "h", EXPORT_ENCRYPTION_KEY: "k", REDIS_URL: "r", SUPABASE_URL: "s",
    } as NodeJS.ProcessEnv);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
