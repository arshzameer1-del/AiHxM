import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { AcknowledgeDisciplinaryRecordDto, CreateEmployeeDisciplinaryRecordDto, WithdrawDisciplinaryRecordDto } from "./dto/employee-disciplinary.dto";
import { EmployeeDisciplinaryService } from "./employee-disciplinary.service";

/** BACKLOG54 - disciplinary records (strict access). */
@Controller("employees/disciplinary")
@UseGuards(SessionGuard)
export class EmployeeDisciplinaryController {
  constructor(private readonly disciplinary: EmployeeDisciplinaryService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.disciplinary.list(claims, employeeId);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeDisciplinaryRecordDto) {
    return this.disciplinary.create(claims, dto);
  }

  @Post(":id/withdraw")
  withdraw(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: WithdrawDisciplinaryRecordDto) {
    return this.disciplinary.withdraw(claims, id, dto.reason);
  }

  @Post(":id/acknowledge")
  acknowledge(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AcknowledgeDisciplinaryRecordDto) {
    return this.disciplinary.acknowledge(claims, id, dto.comment);
  }
}
