import { Body, Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SignupService } from "./signup.service";
import { SignupDto } from "./dto/signup.dto";

/**
 * The one deliberately-unauthenticated write endpoint in the whole API
 * outside `/auth/*` — anyone can call it, by design (that's what "self
 * service signup" means). Rate-limited the same way `/auth/*` already
 * is, for the same reason: an unauthenticated endpoint that writes to
 * the database is the obvious target for automated abuse.
 */
@Controller()
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Post("signup")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Body() dto: SignupDto) {
    return this.signup.signup(dto);
  }
}
