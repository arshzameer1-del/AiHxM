import { Controller, Get, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { OrgStructureService } from "./org-structure.service";

/** The structure tree-table. Access is decided by the services it reads from (org unit / position / employee view scope). */
@Controller("organization/structure")
@UseGuards(SessionGuard)
export class OrgStructureController {
  constructor(private readonly structure: OrgStructureService) {}

  @Get()
  get(@CurrentClaims() claims: RequestClaims) {
    return this.structure.getStructure(claims);
  }
}
