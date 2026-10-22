/** A stable colour slot (0-5) for a label, so the same menu item or tile always gets the same tint in the One exD theme. */
export function hueOf(label: string): number {
  let sum = 0;
  for (let i = 0; i < label.length; i++) sum = (sum * 31 + label.charCodeAt(i)) >>> 0;
  return sum % 6;
}
