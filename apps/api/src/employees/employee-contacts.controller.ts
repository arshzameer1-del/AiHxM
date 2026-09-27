import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeContactsService } from "./employee-contacts.service";
import { CreateEmployeeContactDto } from "./dto/create-employee-contact.dto";
import { UpdateEmployeeContactDto } from "./dto/update-employee-contact.dto";

/** Core Employee Enterprise Phase 6 — the Contact card's own CRUD surface, outside the hiring flow (editing an existing employee's contacts). */
@Controller("employees/contacts")
@UseGuards(SessionGuard)
export class EmployeeContactsController {
  constructor(private readonly contacts: EmployeeContactsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeContactDto) {
    return this.contacts.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.contacts.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeContactDto) {
    return this.contacts.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.contacts.end(claims, id);
  }
}
