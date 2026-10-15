/** Reads the "Days" box of the balance adjustment: a non-zero number, positive to grant, negative to remove. */
export function parseAdjustmentDays(text: string): { value: number | null; error: string | null } {
  const t = text.trim();
  if (t === "") return { value: null, error: "Enter the number of days (for example 5 or -2)." };
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(t)) return { value: null, error: "Days must be a number with at most two decimals." };
  const n = Number(t);
  if (n === 0) return { value: null, error: "Days cannot be zero." };
  if (Math.abs(n) > 365) return { value: null, error: "An adjustment cannot be more than 365 days." };
  return { value: n, error: null };
}
