import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { EmployeeChangeRequestAction, EmployeeChangeRequestStatus, EmployeeChangeRequestType } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeChangeRequestsService } from "./employee-change-requests.service";

class SubmitChangeRequestDto {
  @IsIn(["contact", "address", "family_member", "marital_status", "bank_account"])
  requestType!: EmployeeChangeRequestType;

  @IsIn(["add", "update", "end"])
  action!: EmployeeChangeRequestAction;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

class DecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** BACKLOG48 - employees ask, HR decides. */
@Controller("employees/change-requests")
@UseGuards(SessionGuard)
export class EmployeeChangeRequestsController {
  constructor(private readonly requests: EmployeeChangeRequestsService) {}

  @Post()
  submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitChangeRequestDto) {
    return this.requests.submit(claims, dto);
  }

  @Get("mine")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.requests.listMine(claims);
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.requests.cancel(claims, id);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string) {
    const ok = ["pending", "approved", "rejected", "cancelled"].includes(status ?? "") ? (status as EmployeeChangeRequestStatus) : undefined;
    return this.requests.list(claims, ok);
  }

  @Post(":id/approve")
  approve(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecisionDto) {
    return this.requests.approve(claims, id, dto.note);
  }

  @Post(":id/reject")
  reject(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecisionDto) {
    return this.requests.reject(claims, id, dto.note ?? "");
  }
}
