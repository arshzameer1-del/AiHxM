import { passwordProblem } from "./password-policy";

describe("password policy", () => {
  it.each(["short1!", "password", "Password123!", "Passw0rd!!", "aaaaaaaaaaaa", "abcdefghij", "1234567890", "qwertyuiop", "AiHxM12345", "welcome1234"])(
    "rejects %s", (pw) => expect(passwordProblem(pw)).not.toBeNull());
  it.each(["E2eTestPassw0rd!", "Brand-New-Pass-9", "correct horse battery staple", "Tr4in-Station-Lahore-77"])(
    "accepts %s", (pw) => expect(passwordProblem(pw)).toBeNull());
  it("rejects over-long passwords", () => expect(passwordProblem("a1B!".repeat(40))).toMatch(/at most/));
});
