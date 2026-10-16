import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { StarterSetupService } from "./starter-setup.service";

@Controller("starter-setup")
@UseGuards(SessionGuard)
export class StarterSetupController {
  constructor(private readonly starterSetup: StarterSetupService) {}

  @Get()
  status(@CurrentClaims() claims: RequestClaims) {
    return this.starterSetup.getStatus(claims);
  }

  @Post("apply")
  apply(@CurrentClaims() claims: RequestClaims) {
    return this.starterSetup.apply(claims);
  }
}
