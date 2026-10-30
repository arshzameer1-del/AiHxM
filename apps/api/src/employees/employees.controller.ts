import { EMPLOYEE_ID } from "./employee-id-route";
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { pageParams, setTotalCount } from "../common/paging";
import { FormSettingsService } from "../form-settings/form-settings.service";
import { FormLayoutService } from "../form-settings/form-layout.service";
import { CustomFieldsService } from "../custom-fields/custom-fields.service";
import { SessionGuard } from "../auth/session.guard";
import { MyOrgChartService } from "./my-org-chart.service";
import { MyPersonalDataService } from "./my-personal-data.service";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeesService } from "./employees.service";
import { CreateEmployeeDto } from "./dto/create-employee.dto";
import { UpdateEmployeeDto } from "./dto/update-employee.dto";
import { CreateEmployeeLoginDto } from "./dto/create-employee-login.dto";
import { RecordJobHistoryDto, UploadEmployeeDocumentDto } from "./dto/record-job-history.dto";
import { BulkImportEmployeesDto } from "./dto/bulk-import-employees.dto";

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
  constructor(
    private readonly employees: EmployeesService,
    private readonly myOrgChartService: MyOrgChartService,
    private readonly myPersonalData: MyPersonalDataService,
    private readonly formSettings: FormSettingsService,
    private readonly formLayouts: FormLayoutService,
    private readonly customFields: CustomFieldsService
  ) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeDto) {
    return this.employees.create(claims, dto);
  }

  @Get()
  async list(
    @CurrentClaims() claims: RequestClaims,
    @Res({ passthrough: true }) res: Response,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    const page = await this.employees.listPage(claims, pageParams(limit, offset));
    setTotalCount(res, page.total);
    return page.items;
  }

  // "My Org Chart" (Employee Self Service): the caller's own manager chain, peers and reports. Declared before `:id`.
  @Get("me/org-chart")
  myOrgChart(@CurrentClaims() claims: RequestClaims) {
    return this.myOrgChartService.get(claims);
  }

  // "My Personal Data" (Employee Self Service): the caller's own person record and its dated history. Declared before `:id`.
  @Get("me/personal-data")
  myPersonalDataView(@CurrentClaims() claims: RequestClaims) {
    return this.myPersonalData.get(claims);
  }

  @Get("org-chart")
  orgChart(@CurrentClaims() claims: RequestClaims) {
    return this.employees.orgChart(claims);
  }

  // Phase 12 (Bulk Hiring) — declared before `:id` for the same reason
  // `org-chart`/`field-sensitivity` are.
  @Post("bulk-import")
  bulkImport(@CurrentClaims() claims: RequestClaims, @Body() dto: BulkImportEmployeesDto) {
    return this.employees.bulkImportEmployees(claims, dto.csv);
  }

  // Phase 11 (gap #10) — declared before `:id` for the same reason
  // `org-chart` is: Nest matches routes in declaration order, and this
  // literal path would otherwise be swallowed as a `:id` value.
  @Get("field-sensitivity")
  getFieldSensitivityClassification(@CurrentClaims() claims: RequestClaims) {
    return this.employees.getFieldSensitivityClassification(claims);
  }

  @Get(`${EMPLOYEE_ID}`)
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employees.get(claims, id);
  }

  @Patch(`${EMPLOYEE_ID}`)
  async update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeDto) {
    await this.formSettings.enforce(claims, "employee_profile", dto as unknown as Record<string, unknown>, { clear: dto.clearFields });
    const customValues = dto.customFields ?? {};
    // The form designer's rules (read-only fields, required-when) and the custom field values are checked before anything is saved.
    await this.customFields.validateValues(claims, "employee", customValues);
    const current = await this.employees.get(claims, id);
    const savedCustom = await this.customFields.getValues(claims, "employee", id);
    await this.formLayouts.enforce(claims, "employee_profile", dto as unknown as Record<string, unknown>, { ...(current as unknown as Record<string, unknown>), customFields: savedCustom }, { clear: dto.clearFields });
    const updated = await this.employees.update(claims, id, dto);
    await this.customFields.setValues(claims, "employee", id, customValues);
    return updated;
  }

  /** Decision #12 — see EmployeesService.createLogin()'s doc comment. */
  @Post(`${EMPLOYEE_ID}/account`)
  createLogin(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: CreateEmployeeLoginDto) {
    return this.employees.createLogin(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/documents`)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadDocument(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UploadEmployeeDocumentDto,
    @UploadedFile() file: Express.Multer.File
  ) {
    return this.employees.addDocument(claims, id, dto.documentType, file, { expiryDate: dto.expiryDate, note: dto.note });
  }

  @Get(`${EMPLOYEE_ID}/documents`)
  listDocuments(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employees.listDocuments(claims, id);
  }

  @Get(`${EMPLOYEE_ID}/documents/:documentId`)
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

  @Post(`${EMPLOYEE_ID}/job-history`)
  addJobHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RecordJobHistoryDto) {
    return this.employees.addJobHistory(claims, id, dto);
  }

  @Get(`${EMPLOYEE_ID}/job-history`)
  listJobHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employees.listJobHistory(claims, id);
  }
}
