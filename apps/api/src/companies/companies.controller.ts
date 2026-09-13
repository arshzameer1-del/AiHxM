import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CompaniesService } from "./companies.service";
import { CreateCompanyDto } from "./dto/create-company.dto";
import { UpdateCompanyDto } from "./dto/update-company.dto";
import { UpdateCompanyConfigDto } from "./dto/update-company-config.dto";
import { CreateCompanyAdminDto } from "./dto/create-company-admin.dto";
import { UpdateCompanyAdminDto } from "./dto/update-company-admin.dto";

@Controller("platform/companies")
@UseGuards(PlatformAdminGuard)
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateCompanyDto) {
    return this.companies.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.companies.list(claims);
  }

  @Get(":id")
  getDetail(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.companies.getDetail(claims, id);
  }

  @Patch(":id")
  update(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCompanyDto
  ) {
    return this.companies.updateCompany(claims, id, dto);
  }

  @Patch(":id/config")
  updateConfig(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCompanyConfigDto
  ) {
    return this.companies.updateConfig(claims, id, dto);
  }

  @Post(":id/admins")
  addAdmin(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: CreateCompanyAdminDto
  ) {
    return this.companies.addAdmin(claims, id, dto);
  }

  @Patch(":id/admins/:adminId")
  setAdminStatus(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("adminId") adminId: string,
    @Body() dto: UpdateCompanyAdminDto
  ) {
    return this.companies.setAdminStatus(claims, id, adminId, dto.status);
  }

  @Post(":id/impersonate")
  impersonate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.companies.impersonate(claims, id);
  }
}
