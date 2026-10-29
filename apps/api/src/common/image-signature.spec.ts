import { assertRealImage, detectRasterMime } from "./image-signature";
import { TINY_PNG } from "../testing-tiny-png";

describe("image signature", () => {
  it("detects a real png", () => expect(detectRasterMime(TINY_PNG)).toBe("image/png"));
  it("rejects svg, html and text pretending to be images", () => {
    for (const body of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "<html></html>", "fake"]) {
      expect(() => assertRealImage({ mimetype: "image/png", buffer: Buffer.from(body) })).toThrow(/real/);
    }
  });
  it("rejects a png declared as jpeg", () => {
    expect(() => assertRealImage({ mimetype: "image/jpeg", buffer: TINY_PNG })).toThrow();
  });
  it("accepts a matching png", () => expect(assertRealImage({ mimetype: "image/png", buffer: TINY_PNG })).toBe("image/png"));
});
