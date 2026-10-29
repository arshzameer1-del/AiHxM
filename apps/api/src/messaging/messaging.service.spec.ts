import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MessagingService } from "./messaging.service";

describe("MessagingService", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("turns Pakistani mobile numbers into international form and refuses junk", () => {
    const n = MessagingService.normalizePhone;
    expect(n("0300-1234567")).toBe("+923001234567");
    expect(n("92 300 1234567")).toBe("+923001234567");
    expect(n("+92 300 1234567")).toBe("+923001234567");
    expect(n("00923001234567")).toBe("+923001234567");
    expect(n("3001234567")).toBe("+923001234567");
    expect(n("12")).toBeNull();
    expect(n("")).toBeNull();
    expect(n(null)).toBeNull();
  });

  it("is not configured, and sends nothing, until a provider is set", async () => {
    for (const k of ["SMS_WEBHOOK_URL", "WHATSAPP_WEBHOOK_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM", "TWILIO_WHATSAPP_FROM"]) delete process.env[k];
    const svc = new MessagingService();
    expect(svc.status()).toEqual({ sms: { configured: false, provider: null }, whatsapp: { configured: false, provider: null } });
    expect(await svc.send("sms", "03001234567", "hi")).toMatchObject({ ok: false });
  });

  it("detects Twilio per channel from its settings", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "t";
    process.env.TWILIO_SMS_FROM = "+15005550006";
    const svc = new MessagingService();
    expect(svc.status().sms).toEqual({ configured: true, provider: "twilio" });
    expect(svc.status().whatsapp.configured).toBe(false);
  });

  describe("webhook gateway", () => {
    let server: Server;
    let received: Array<{ auth: string | undefined; body: unknown }> = [];
    let answer = 200;
    beforeAll(async () => {
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
          res.statusCode = answer;
          res.setHeader("x-message-id", "m-1");
          res.end("{}");
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    beforeEach(() => {
      received = [];
      answer = 200;
      process.env.WHATSAPP_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`;
      process.env.WHATSAPP_WEBHOOK_TOKEN = "secret";
    });

    it("posts the message with the number in international form and reports the gateway's answer", async () => {
      const svc = new MessagingService();
      expect(svc.isConfigured("whatsapp")).toBe(true);
      expect(await svc.send("whatsapp", "0300 1234567", "Office closed Monday")).toEqual({ ok: true, providerRef: "m-1" });
      expect(received).toEqual([{ auth: "Bearer secret", body: { channel: "whatsapp", to: "+923001234567", text: "Office closed Monday" } }]);
      answer = 500;
      expect(await svc.send("whatsapp", "03001234567", "x")).toEqual({ ok: false, error: "The gateway answered 500" });
      expect(await svc.send("whatsapp", "abc", "x")).toMatchObject({ ok: false });
    });
  });
});
