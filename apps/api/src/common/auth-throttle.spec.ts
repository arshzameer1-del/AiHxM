import { authAccountTracker, isAuthStepPath } from "./auth-throttle";

describe("auth throttle tracker", () => {
  it("separates accounts behind one address", () => {
    const a = authAccountTracker({ ip: "1.2.3.4", body: { email: "a@x.com" } });
    const b = authAccountTracker({ ip: "1.2.3.4", body: { email: "b@x.com" } });
    expect(a).not.toBe(b);
  });
  it("is case-insensitive for the same account and differs per address", () => {
    expect(authAccountTracker({ ip: "1.1.1.1", body: { email: "A@x.com" } })).toBe(authAccountTracker({ ip: "1.1.1.1", body: { email: "a@X.com" } }));
    expect(authAccountTracker({ ip: "1.1.1.1", body: { email: "a@x.com" } })).not.toBe(authAccountTracker({ ip: "2.2.2.2", body: { email: "a@x.com" } }));
  });
  it("tracks employee logins by company and number, and code steps by ticket", () => {
    expect(authAccountTracker({ ip: "i", body: { companySlug: "c", employeeNumber: "E1" } })).not.toBe(authAccountTracker({ ip: "i", body: { companySlug: "c", employeeNumber: "E2" } }));
    expect(authAccountTracker({ ip: "i", body: { mfaTicket: "t1" } })).not.toBe(authAccountTracker({ ip: "i", body: { mfaTicket: "t2" } }));
  });
  it("applies the broad cap to sign-in routes only", () => {
    expect(isAuthStepPath("/auth/login")).toBe(true);
    expect(isAuthStepPath("/auth/mfa/verify")).toBe(true);
    expect(isAuthStepPath("/employees")).toBe(false);
  });
});
