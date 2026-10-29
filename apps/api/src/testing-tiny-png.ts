/** A real 1x1 PNG, for tests that upload a "picture" (uploads are checked against the real file signature). */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export function tinyPngFile(name = "pic.png") {
  return { originalname: name, mimetype: "image/png", buffer: TINY_PNG, size: TINY_PNG.length };
}
