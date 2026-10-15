/**
 * Gap Register SEC-13 — PII must never reach events, webhooks, prompts or
 * telemetry. Every domain-event payload passes through `redactPayload()`
 * before it is stored; anything whose KEY looks sensitive is replaced by a
 * marker (the value is dropped, not hashed — an event consumer has no
 * legitimate need for it, and hashes of low-entropy CNICs are reversible).
 * Extend SENSITIVE_KEY, never loosen it.
 */
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(cnic|nic_?number|national_?id|passport|ssn|bank|account_?(no|number|num)|iban|swift|salary|wage|gross|net_?pay|basic_?pay|compensation|password|passwd|secret|token|api_?key|private_?key|mfa|otp|date_?of_?birth|dob)/i;

export function redactPayload<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // camelCase -> snake_case so "bankAccountNumber" matches the same rules
    const normalized = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    out[k] = SENSITIVE_KEY.test(normalized) ? REDACTED : redactPayload(v, depth + 1);
  }
  return out as T;
}

/** 'employee.*' matches 'employee.hired' and 'employee.address.changed'; '*' matches all. */
export function eventTypeMatches(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1));
  return pattern === eventType;
}

/**
 * Narrower rules for AUDIT metadata. The audit log is append-only: whatever
 * is written there can never be erased, so raw identifiers must never reach
 * it. Unlike event payloads, audit trails legitimately record business fields
 * such as salaryBand or bankName, so this list is identifiers/secrets only.
 */
const AUDIT_SENSITIVE_KEY =
  /(cnic|nic_?number|national_?id|passport|ssn|account_?(no|number|num)|bank_?account|iban|date_?of_?birth|dob|password|passwd|secret|api_?key|private_?key|otp|mfa_?secret|signing_?secret)/i;

// Sub-trees whose KEYS are field names but whose VALUES are classifications
// (e.g. { tiers: { cnic: "restricted" } }), never data -- left intact.
const AUDIT_EXEMPT_CONTAINER = /^(tiers|field_?tiers|classifications?|sensitivity)$/i;

export function redactForAudit<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const normalized = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    if (AUDIT_EXEMPT_CONTAINER.test(k)) {
      out[k] = v;
      continue;
    }
    out[k] = AUDIT_SENSITIVE_KEY.test(normalized) && v !== null && v !== undefined ? REDACTED : redactForAudit(v, depth + 1);
  }
  return out as T;
}
