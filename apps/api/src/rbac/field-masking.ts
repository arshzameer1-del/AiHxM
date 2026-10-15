/**
 * ACC-01 -- value masking for the `masked` field access level.
 *
 * A masked field is returned to the caller, but with its value obscured by
 * the rule's `mask_rule` (default `full`). The raw value never leaves the
 * engine for a caller whose resolved access is `masked`.
 */
export type MaskRule = "full" | "last4" | "first1" | "email";

const BULLET = "•";

export function maskValue(value: unknown, rule: string | null | undefined): unknown {
  if (value === null || value === undefined) return value;
  const r = (rule ?? "full") as MaskRule;
  if (typeof value !== "string" && typeof value !== "number") {
    // objects, arrays, booleans: never partially reveal structure
    return BULLET.repeat(4);
  }
  const text = String(value);
  if (text.length === 0) return text;
  switch (r) {
    case "last4":
      return text.length <= 4 ? BULLET.repeat(text.length) : BULLET.repeat(text.length - 4) + text.slice(-4);
    case "first1":
      return text.length <= 1 ? BULLET.repeat(text.length) : text[0] + BULLET.repeat(text.length - 1);
    case "email": {
      const at = text.indexOf("@");
      if (at <= 0) return BULLET.repeat(Math.min(text.length, 8));
      return text[0] + BULLET.repeat(Math.max(at - 1, 1)) + text.slice(at);
    }
    case "full":
    default:
      return BULLET.repeat(Math.min(text.length, 8));
  }
}
