import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { JobsService } from "./jobs.service";
import { CreateJobDto } from "./dto/create-job.dto";
import { UpdateJobDto } from "./dto/update-job.dto";

/**
 * Any real session (SessionGuard) can call these — JobsService's own
 * entitlement + job.manage.all/job.view.all checks are what actually
 * decide who succeeds, the same split OrgUnitsController uses.
 */
@Controller("organization/jobs")
@UseGuards(SessionGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateJobDto) {
    return this.jobs.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.jobs.list(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.jobs.get(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.jobs.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateJobDto) {
    return this.jobs.update(claims, id, dto);
  }

  @Post(":id/activate")
  activate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.jobs.activate(claims, id);
  }

  @Post(":id/archive")
  archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.jobs.archive(claims, id);
  }
}
