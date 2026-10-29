/** The server accepts selfies up to 60 KB; aim lower so the JSON body stays well inside its limit. */
export const SELFIE_TARGET_BYTES = 48 * 1024;

/** Size of the thumbnail: the longest side becomes `max` pixels, the picture is never enlarged. */
export function scaledSize(width: number, height: number, max = 320): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Approximate decoded size of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
}

/** Turns a photo from the camera or the file picker into a small JPEG data URL, lowering the quality until it fits. */
export async function selfieFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot prepare the photo.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let url = canvas.toDataURL("image/jpeg", 0.7);
  for (const q of [0.55, 0.4, 0.3, 0.2]) {
    if (dataUrlBytes(url) <= SELFIE_TARGET_BYTES) break;
    url = canvas.toDataURL("image/jpeg", q);
  }
  if (dataUrlBytes(url) > SELFIE_TARGET_BYTES * 1.2) throw new Error("The photo is too detailed to send. Take another one.");
  return url;
}
