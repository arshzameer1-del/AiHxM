import { BadRequestException } from "@nestjs/common";

export type RasterMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** What the first bytes of the file really are. The browser-supplied content type can be anything, so it is never trusted alone. */
export function detectRasterMime(buf: Buffer): RasterMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  return null;
}

/**
 * Accepts the upload only when its bytes are one of the allowed picture types AND agree with the declared type.
 * SVG is deliberately not allowed: it can carry script, and these pictures are served from the API's own address.
 */
export function assertRealImage(
  file: { mimetype: string; buffer: Buffer },
  allowed: RasterMime[] = ["image/png", "image/jpeg", "image/webp"],
  label = "picture"
): RasterMime {
  const real = detectRasterMime(file.buffer);
  if (!real || !allowed.includes(real) || real !== file.mimetype.toLowerCase().replace("image/jpg", "image/jpeg")) {
    const names = allowed.map((m) => m.replace("image/", "").toUpperCase()).join(", ");
    throw new BadRequestException(`The ${label} must be a real ${names} image`);
  }
  return real;
}
