import { assertSafeOutboundUrl, isPrivateAddress, UnsafeOutboundUrlError } from "./safe-outbound";

describe("safe outbound urls", () => {
  const saved = process.env.OUTBOUND_ALLOW_PRIVATE;
  beforeAll(() => { process.env.OUTBOUND_ALLOW_PRIVATE = "false"; });
  afterAll(() => { process.env.OUTBOUND_ALLOW_PRIVATE = saved; });

  it.each(["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])(
    "treats %s as private", (a) => expect(isPrivateAddress(a)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("treats %s as public", (a) => expect(isPrivateAddress(a)).toBe(false));

  it.each([
    "http://example.com/hook",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://user:pw@example.com/x",
    "https://example.com:6379/x",
    "https://db.internal/x",
    "ftp://example.com/x",
    "not a url",
  ])("rejects %s", async (u) => {
    await expect(assertSafeOutboundUrl(u)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it("accepts a public https address given as an IP", async () => {
    await expect(assertSafeOutboundUrl("https://8.8.8.8/hook")).resolves.toBeInstanceOf(URL);
  });
});
