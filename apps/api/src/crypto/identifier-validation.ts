import { BadRequestException } from "@nestjs/common";

/**
 * Gap Register EMP-20 -- format validation for Pakistani identifiers.
 *
 * These cannot be database CHECK constraints: since SEC-02 the columns hold
 * ciphertext. They are enforced in the services (and at hire-card save) and
 * surface as field-level 400 errors naming the field.
 *
 *  - CNIC: 13 digits; the usual 12345-1234567-1 dashes/spaces are accepted
 *    and the value is stored as the user typed it (never reformatted).
 *  - IBAN: ISO 13616. Pakistan IBANs are 24 characters, PK + 2 check digits
 *    + 4-letter bank code + 16 digits, verified with the mod-97 checksum.
 *    Other countries' IBANs (overseas payees) are checked for structure and
 *    checksum only.
 */
export function isValidCnic(value: string): boolean {
  return /^\d{13}$/.test(value.replace(/[\s-]/g, ""));
}

export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith("PK") && !/^PK\d{2}[A-Z]{4}\d{16}$/.test(iban)) return false;
  // mod-97 over the rearranged string with letters expanded to 10..35
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export function assertValidCnic(value: string | null | undefined, field = "cnic"): void {
  if (value === null || value === undefined || value === "") return;
  if (!isValidCnic(value)) {
    throw new BadRequestException({ message: "CNIC must be 13 digits (for example 35202-1234567-1).", field });
  }
}

export function assertValidIban(value: string | null | undefined, field = "iban"): void {
  if (value === null || value === undefined || value === "") return;
  if (!isValidIban(value)) {
    throw new BadRequestException({ message: "IBAN is not valid. A Pakistani IBAN has 24 characters, for example PK36SCBL0000001123456702.", field });
  }
}
