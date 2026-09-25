import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { SupportTicketPriority, SupportTicketStatus } from "@aihxm/shared-types";
import { SupportTicketsService } from "./support-tickets.service";

const PRIORITIES: SupportTicketPriority[] = ["low", "normal", "high", "urgent"];
const STATUSES: SupportTicketStatus[] = ["open", "in_progress", "resolved", "closed"];

class CreateTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: SupportTicketPriority;
}

class UpdateTicketDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: SupportTicketStatus;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: SupportTicketPriority;

  @IsOptional()
  @IsString()
  assignee?: string | null;
}

// TM-033 — Support tickets.
@Controller("platform/companies/:companyId/support-tickets")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class SupportTicketsController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Query("status") status?: SupportTicketStatus
  ) {
    return this.tickets.list(claims, companyId, { status });
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string, @Body() dto: CreateTicketDto) {
    return this.tickets.create(claims, companyId, dto);
  }

  @Patch(":ticketId")
  update(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("ticketId") ticketId: string,
    @Body() dto: UpdateTicketDto
  ) {
    return this.tickets.update(claims, companyId, ticketId, dto);
  }
}
