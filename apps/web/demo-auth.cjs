// Shared login helper for the demo-seeding/screenshot scripts. Persists
// each demo account's TOTP secret locally (dev-only sandbox, throwaway
// data) so repeated script runs and the later Playwright screenshot pass
// can all log in as the same account without re-triggering MFA setup.
const fs = require("fs");
const path = require("path");
const { generateSync } = require("otplib");

const SECRETS_FILE = path.join(__dirname, ".demo-secrets.json");

function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSecret(email, secret) {
  const secrets = loadSecrets();
  secrets[email] = secret;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

async function j(method, path_, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://localhost:4000${path_}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path_} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function login(email, password) {
  const first = await j("POST", "/auth/login", { email, password });
  if (first.status === "mfa_setup_required") {
    const code = generateSync({ secret: first.secretForManualEntry });
    const confirmed = await j("POST", "/auth/mfa/enroll/confirm", { mfaTicket: first.mfaTicket, code });
    saveSecret(email, first.secretForManualEntry);
    return confirmed.token;
  }
  if (first.status === "mfa_required") {
    const secrets = loadSecrets();
    const secret = secrets[email];
    if (!secret) throw new Error(`No stored TOTP secret for ${email} — MFA already enrolled but secret unknown.`);
    const code = generateSync({ secret });
    const verified = await j("POST", "/auth/mfa/verify", { mfaTicket: first.mfaTicket, code });
    return verified.token;
  }
  throw new Error("Unexpected login response: " + JSON.stringify(first));
}

module.exports = { j, login, loadSecrets, saveSecret };
