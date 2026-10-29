import { registerDecorator, type ValidationOptions } from "class-validator";

/**
 * One password rule for every place a password is chosen (sign-up, reset, change, admin-set, new login):
 * 10 to 128 characters, not a well-known password, not one repeated or sequential run, and not letters-only/digits-only
 * short patterns. Length is the main defence; the list stops the passwords attackers try first.
 * (Passwords are bcrypt-hashed; bcrypt only reads the first 72 bytes, so 128 is just a sanity ceiling.)
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_BASES = new Set(
  (
    "password passw0rd p@ssword p@ssw0rd pass1234 password1 qwerty qwertyuiop qwerty123 asdfghjkl zxcvbnm 1qaz2wsx 1q2w3e4r " +
    "letmein welcome welcome1 admin administrator adminadmin root toor login changeme changeit secret iloveyou monkey dragon " +
    "football baseball master sunshine princess shadow superman batman trustno1 abc123 abcd1234 abcdefgh abcdefghij " +
    "pakistan pakistan1 islamabad lahore karachi allah123 muhammad ali12345 hello123 hellohello test1234 testtest testing " +
    "default guest user1234 temp1234 temporary aihxm aihxm123 company companyadmin hradmin hr12345 payroll salary employee employee1 " +
    "newpassword new12345 mypassword myPassword123 letmein123 passpass starwars whatever freedom computer internet"
  )
    .toLowerCase()
    .split(/\s+/)
);

function base(pw: string): string {
  // strip trailing digits/symbols so "Password123!" is caught as "password"
  return pw.toLowerCase().replace(/[\d\W_]+$/g, "").replace(/^[\d\W_]+/g, "");
}

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string") return "must be text";
  if (pw.length < PASSWORD_MIN_LENGTH) return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (pw.length > PASSWORD_MAX_LENGTH) return `must be at most ${PASSWORD_MAX_LENGTH} characters`;
  const lower = pw.toLowerCase();
  if (COMMON_BASES.has(lower) || COMMON_BASES.has(base(pw))) return "is too common; choose something less guessable";
  if (/^(.)\1+$/.test(pw)) return "must not be one repeated character";
  if (new Set(lower).size <= 3) return "must use more different characters";
  const seq = "abcdefghijklmnopqrstuvwxyz" + "01234567890123456789";
  if (seq.includes(lower) || [...seq].reverse().join("").includes(lower)) return "must not be a simple sequence";
  return null;
}

export function IsStrongPassword(options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: "isStrongPassword",
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (value) => passwordProblem(value) === null,
        defaultMessage: (args) => `${args?.property} ${passwordProblem(args?.value) ?? "is not acceptable"}`,
      },
    });
  };
}
