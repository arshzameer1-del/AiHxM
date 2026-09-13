import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeesService } from "./employees.service";
import { CreateEmployeeDto } from "./dto/create-employee.dto";
import { UpdateEmployeeDto } from "./dto/update-employee.dto";
import { RecordJobHistoryDto, UploadEmployeeDocumentDto } from "./dto/record-job-history.dto";

/**
 * Any real session (SessionGuard, same as DummyController) can call
 * these — what a given caller actually sees or is allowed to write is
 * entirely down to EmployeesService's own entitlement + RBAC checks, the
 * same split every module since Phase 4 has used. `org-chart` is declared
 * before the `:id` route deliberately — Nest matches routes in
 * declaration order within a controller, and "org-chart" would otherwise
 * be swallowed as a (non-UUID, so still 404s, but for the wrong reason)
 * `:id` value.
 */
@Controller("employees")
@UseGuards(SessionGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeDto) {
    return this.employees.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.employees.list(claims);
  }

  @Get("org-chart")
  orgChart(@CurrentClaims() claims: RequestClaims) {
    return this.employees.orgChart(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employees.get(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(claims, id, dto);
  }

  @Post(":id/documents")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadDocument(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UploadEmployeeDocumentDto,
    @UploadedFile() file: Express.Multer.File
  ) {
    return this.employees.addDocument(claims, id, dto.documentType, file);
  }

  @Get(":id/documents")
  listDocuments(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employees.listDocuments(claims, id);
  }

  @Get(":id/documents/:documentId")
  async downloadDocument(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Res() res: Response
  ) {
    const { buffer, fileName, mimeType } = await this.employees.downloadDocument(claims, id, documentId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    res.send(buffer);
  }

  @Post(":id/job-history")
  addJobHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RecordJobHistoryDto) {
    return this.employees.addJobHistory(claims, id, dto);
  }

  @Get(":id/job-history")
  listJobHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employees.listJobHistory(claims, id);
  }
}
