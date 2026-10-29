import * as bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

let dummyHash: Promise<string> | null = null;
/**
 * Burns the same time as a real password check. Called when the account does not exist so that "unknown email" and
 * "wrong password" take equally long and a stranger cannot tell which emails have accounts.
 */
export async function verifyAgainstDummy(plain: string): Promise<void> {
  dummyHash ??= bcrypt.hash("aihxm-timing-equalizer", BCRYPT_ROUNDS);
  await bcrypt.compare(plain, await dummyHash);
}
