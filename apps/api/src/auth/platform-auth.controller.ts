import { Body, Controller, Post, UnauthorizedException } from "@nestjs/common";
import { IsString, MinLength } from "class-validator";
import { timingSafeEqual } from "crypto";
import * as jwt from "jsonwebtoken";

class LoginDto {
  @IsString()
  @MinLength(1)
  password!: string;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch rather than returning
  // false, and the lengths themselves are not secret here, so padding is
  // fine — the point is only to avoid leaking the password byte-by-byte
  // via response timing.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * One shared platform-admin credential, dev-only, explicitly temporary —
 * see PlatformAdminGuard's doc comment. There is no per-admin identity
 * yet, so every token this issues carries the same `sub`.
 */
@Controller("platform/auth")
export class PlatformAuthController {
  @Post("login")
  login(@Body() body: LoginDto) {
    const expected = process.env.PLATFORM_ADMIN_DEV_PASSWORD;
    const secret = process.env.JWT_SECRET;
    if (!expected || !secret) {
      throw new Error("PLATFORM_ADMIN_DEV_PASSWORD or JWT_SECRET is not set");
    }

    if (!safeEqual(body.password, expected)) {
      throw new UnauthorizedException("Incorrect password");
    }

    const token = jwt.sign(
      { sub: "platform-admin-dev", is_platform_admin: true },
      secret,
      { expiresIn: "12h" }
    );

    return { token };
  }
}
