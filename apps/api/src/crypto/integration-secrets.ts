import type { PoolClient } from "pg";
import { fieldCrypto } from "./field-crypto";

/**
 * Gap Register SEC-03 -- secret fields inside `tenant_integrations.config`
 * (jsonb) are stored as `enc:v1:` ciphertext. Explicit allow-list per
 * provider: a new secret field must be added here on purpose (fail closed),
 * the same posture as the integrations service's redaction.
 */
export const INTEGRATION_SECRET_FIELDS: Record<string, string[]> = {
  smtp: ["password"],
  sso: ["clientSecret"],
  biometric_device: ["apiKey"],
  webhook: ["signingSecret"],
};

/** Encrypts the provider's secret fields (idempotent; leaves other keys alone). Keys must be warmed. */
export function encryptIntegrationConfig(companyId: string, providerKey: string, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const field of INTEGRATION_SECRET_FIELDS[providerKey] ?? []) {
    const v = out[field];
    if (typeof v === "string" && v) out[field] = fieldCrypto.encrypt(companyId, v);
  }
  return out;
}

/** Warms the tenant's keys (platform/service paths run without a company in claims) then decrypts secret fields. */
export async function decryptIntegrationConfig(
  client: Pick<PoolClient, "query">,
  companyId: string,
  providerKey: string,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  await fieldCrypto.warm(client as PoolClient, companyId);
  const out = { ...config };
  for (const field of INTEGRATION_SECRET_FIELDS[providerKey] ?? []) {
    const v = out[field];
    if (typeof v === "string" && v) out[field] = fieldCrypto.decrypt(companyId, v);
  }
  return out;
}
