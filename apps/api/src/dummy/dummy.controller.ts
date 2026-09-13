import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DummyService } from "./dummy.service";

/**
 * Any real session (Platform Admin or Company Super Admin today; Employee/
 * Manager from Phase 7) can call these — SessionGuard only checks "is this
 * a valid session," not tier. What each caller actually sees is entirely
 * down to RbacService (see DummyService), which is the whole point of
 * this phase: prove the engine decides visibility, not the guard.
 */
@Controller("rbac-demo/dummy-records")
@UseGuards(SessionGuard)
export class DummyController {
  constructor(private readonly dummy: DummyService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.dummy.list(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.dummy.get(claims, id);
  }
}
