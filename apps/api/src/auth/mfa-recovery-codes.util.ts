import { randomInt } from "crypto";

/**
 * Tenant Management gap-fill batch 1 — MFA recovery codes (see the
 * "MFA recovery codes" row under Authentication & MFA in the 1,000-gap
 * backlog). MFA is mandatory for every account (Phase 3) with no fallback
 * today if the authenticator device is lost — a Platform Admin can reset
 * a password, but nothing un-sticks a locked MFA enrollment short of a
 * direct database edit. This is the standard fallback every real MFA
 * implementation ships (Google, GitHub, AWS): a batch of single-use codes,
 * issued once at enrollment, each usable exactly once instead of a TOTP
 * code.
 *
 * Excludes visually-ambiguous characters (0/O, 1/I/L) since these are
 * meant to be hand-copied/written down, not just clicked — same reasoning
 * as most real-world implementations of this same feature.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 10;
const CODES_PER_BATCH = 10;

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (i === 4) out += "-"; // "ABCDE-FGHJK" — easier to read/type in one piece each half.
  }
  return out;
}

/** A fresh batch of plaintext codes — shown to the user exactly once by the caller, never persisted as-is. */
export function generateRecoveryCodes(count: number = CODES_PER_BATCH): string[] {
  return Array.from({ length: count }, randomCode);
}

/** Normalizes a user-typed code the same way before hashing AND before comparing at verify time (case/whitespace only — never loosen beyond that, these are still one-shot credentials). */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}
