import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DummyService } from "./dummy.service";
import { CreateDummyRecordDto } from "./dto/create-dummy-record.dto";

/**
 * Separate from DummyController deliberately: creating fixture data is a
 * Platform-Admin/test-setup action (matches dummy_records' write RLS
 * policy), reading it through the RBAC engine is an ordinary-session
 * action (DummyController, SessionGuard) — the same split as every other
 * object in this codebase between "who can administer this" and "who can
 * use it."
 */
@Controller("platform/dummy-records")
@UseGuards(PlatformAdminGuard)
export class DummyFixturesController {
  constructor(private readonly dummy: DummyService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateDummyRecordDto) {
    return this.dummy.create(claims, dto);
  }
}
