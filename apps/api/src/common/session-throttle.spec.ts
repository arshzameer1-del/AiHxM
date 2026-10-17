import * as jwt from "jsonwebtoken";
import { sessionSubject } from "./session-throttle";

describe("sessionSubject", () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret-for-throttle";
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD;
  });
  const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} });

  it("returns the person for a genuine session token", () => {
    const t = jwt.sign({ sub: "user-1", jti: "j1" }, "test-secret-for-throttle");
    expect(sessionSubject(req(`Bearer ${t}`))).toBe("user-1");
  });
  it("ignores no token, a forged token and an expired token", () => {
    expect(sessionSubject(req())).toBeNull();
    expect(sessionSubject(req(`Bearer ${jwt.sign({ sub: "x", jti: "j" }, "other-secret")}`))).toBeNull();
    expect(sessionSubject(req(`Bearer ${jwt.sign({ sub: "x", jti: "j" }, "test-secret-for-throttle", { expiresIn: -10 })}`))).toBeNull();
    expect(sessionSubject(req("Bearer garbage"))).toBeNull();
  });
  it("does not treat a login-step ticket or a token without a session id as a session", () => {
    expect(sessionSubject(req(`Bearer ${jwt.sign({ typ: "mfa_ticket", purpose: "mfa_verify", userAccountId: "u" }, "test-secret-for-throttle")}`))).toBeNull();
    expect(sessionSubject(req(`Bearer ${jwt.sign({ sub: "user-1" }, "test-secret-for-throttle")}`))).toBeNull();
  });
});
