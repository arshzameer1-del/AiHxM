import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DataSubjectRequestsService } from "./data-subject-requests.service";
import { SubmitDataSubjectRequestDto } from "./dto/submit-data-subject-request.dto";
import { DecideDataSubjectRequestDto } from "./dto/decide-data-subject-request.dto";
import { FulfillDataSubjectRequestDto } from "./dto/fulfill-data-subject-request.dto";

/**
 * Any real session can call these (SessionGuard) — DataSubjectRequestsService's
 * own entitlement + permission (and, for decisions, workflow-routing)
 * checks are what actually decide who succeeds, the same split
 * LeaveController/leave-requests.service.ts already uses.
 */
@Controller("data-subject-requests")
@UseGuards(SessionGuard)
export class DataSubjectRequestsController {
  constructor(private readonly dataSubjectRequests: DataSubjectRequestsService) {}

  @Post()
  submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitDataSubjectRequestDto) {
    return this.dataSubjectRequests.submit(claims, dto);
  }

  // Placed before ":id" so "mine" is never captured by the :id param route.
  @Get("mine")
  listMine(@CurrentClaims() claims: RequestClaims) {
    return this.dataSubjectRequests.listMine(claims);
  }

  @Get()
  listQueue(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string) {
    return this.dataSubjectRequests.listQueue(claims, { status });
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.dataSubjectRequests.getRequest(claims, id);
  }

  @Post(":id/decide")
  decide(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideDataSubjectRequestDto) {
    return this.dataSubjectRequests.decide(claims, id, dto);
  }

  @Post(":id/fulfill")
  fulfill(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: FulfillDataSubjectRequestDto) {
    return this.dataSubjectRequests.fulfill(claims, id, dto);
  }
}
