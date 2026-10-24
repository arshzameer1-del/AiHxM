/** BACKLOG51 - small pure helpers for the Account page. */

export const MIN_PASSWORD_LENGTH = 10;

/** What is wrong with the change-password form, or null when it can be sent. Mirrors the server's rules. */
export function passwordProblem(current: string, next: string, confirm: string): string | null {
  if (!current) return "Enter your current password.";
  if (next.length < MIN_PASSWORD_LENGTH) return `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (next === current) return "Choose a new password that is different from the current one.";
  if (next !== confirm) return "The new password and its confirmation do not match.";
  return null;
}

/** A readable name for a browser's user-agent string, e.g. "Chrome on Windows". */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad|iOS/.test(ua) ? "iPhone / iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Splits a recovery code batch into a printable text block. */
export function recoveryCodesText(codes: string[]): string {
  return ["AiHxM recovery codes - each works once.", "", ...codes].join("\n");
}
