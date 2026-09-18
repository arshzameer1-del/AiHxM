import { Controller, Get, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ConfigurationCenterService } from "./configuration-center.service";

@Controller("configuration-center")
@UseGuards(SessionGuard)
export class ConfigurationCenterController {
  constructor(private readonly configurationCenter: ConfigurationCenterService) {}

  @Get()
  getSummary(@CurrentClaims() claims: RequestClaims) {
    return this.configurationCenter.getSummary(claims);
  }
}
