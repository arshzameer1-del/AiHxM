import { BadRequestException } from "@nestjs/common";
import { assertValidCnic, assertValidIban, isValidCnic, isValidIban } from "./identifier-validation";

describe("identifier-validation (EMP-20)", () => {
  it("accepts a 13-digit CNIC with or without dashes/spaces", () => {
    expect(isValidCnic("3520212345671")).toBe(true);
    expect(isValidCnic("35202-1234567-1")).toBe(true);
    expect(isValidCnic("35202 1234567 1")).toBe(true);
  });

  it("rejects CNICs of the wrong length or with letters", () => {
    expect(isValidCnic("352021234567")).toBe(false);
    expect(isValidCnic("35202123456712")).toBe(false);
    expect(isValidCnic("35202-123456A-1")).toBe(false);
    expect(isValidCnic("1234-REHIRE")).toBe(false);
  });

  it("accepts valid Pakistani IBANs (spaces/lowercase tolerated)", () => {
    expect(isValidIban("PK36SCBL0000001123456702")).toBe(true);
    expect(isValidIban("pk36 scbl 0000 0011 2345 6702")).toBe(true);
    expect(isValidIban("PK22HABB0000123456789012")).toBe(true);
  });

  it("rejects bad checksum, wrong PK length or shape", () => {
    expect(isValidIban("PK37SCBL0000001123456702")).toBe(false); // checksum
    expect(isValidIban("PK00HABB0000123456789")).toBe(false); // too short
    expect(isValidIban("PK36SCBL000000112345670")).toBe(false);
    expect(isValidIban("not-an-iban")).toBe(false);
  });

  it("accepts a valid non-PK IBAN by checksum (overseas payee)", () => {
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
    expect(isValidIban("GB83WEST12345698765432")).toBe(false);
  });

  it("assert helpers pass empty values and throw field-level 400s otherwise", () => {
    expect(() => assertValidCnic(undefined)).not.toThrow();
    expect(() => assertValidCnic("")).not.toThrow();
    expect(() => assertValidIban(null)).not.toThrow();
    try {
      assertValidCnic("abc", "cnic");
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({ field: "cnic" });
    }
    expect(() => assertValidIban("PK00BAD")).toThrow(BadRequestException);
  });
});
