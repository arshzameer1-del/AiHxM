import { Controller, Get, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { OrganizationCommandCenterService } from "./organization-command-center.service";

/** One endpoint, backing the "Organization Command Center" panel on the
 * portal home page — see `OrganizationCommandCenterService`'s own class
 * doc comment for the full scoping rationale. */
@Controller("organization/command-center")
@UseGuards(SessionGuard)
export class OrganizationCommandCenterController {
  constructor(private readonly commandCenter: OrganizationCommandCenterService) {}

  @Get()
  getSummary(@CurrentClaims() claims: RequestClaims) {
    return this.commandCenter.getSummary(claims);
  }
}
