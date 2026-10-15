import { Pool } from "pg";
import { decryptMfaSecret } from "../auth/mfa-secret-crypto";
import { generate as generateTotp } from "otplib";

async function main() {
  const pool = new Pool({ connectionString: "postgresql://aihxm:aihxm_dev@localhost:5432/aihxm" });
  const client = await pool.connect();
  const res = await client.query("SELECT mfa_secret_encrypted FROM user_accounts WHERE email = $1", [
    "kumail-ui-test@example.com",
  ]);
  const enc = res.rows[0]?.mfa_secret_encrypted;
  if (!enc) {
    console.log("NO_SECRET");
  } else {
    const secret = decryptMfaSecret(enc);
    const code = await generateTotp({ secret });
    console.log("CODE:" + code);
  }
  client.release();
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
