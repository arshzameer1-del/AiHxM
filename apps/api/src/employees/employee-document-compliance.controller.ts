import { Body, Controller, Get, Param, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { UploadEmployeeDocumentDto } from "./dto/record-job-history.dto";
import { EMPLOYEE_ID } from "./employee-id-route";
import { EmployeeDocumentComplianceService } from "./employee-document-compliance.service";

class RequiredDocumentsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  documentTypes!: string[];
}

class ReviewDocumentDto {
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** BACKLOG50 - document review inbox, mandatory document types, per-employee checklist and profile photo. */
@Controller("employees")
@UseGuards(SessionGuard)
export class EmployeeDocumentComplianceController {
  constructor(private readonly compliance: EmployeeDocumentComplianceService) {}

  /** An employee's own upload; waits as 'pending' until HR approves it. */
  @Post(`${EMPLOYEE_ID}/documents/own`)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadOwn(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UploadEmployeeDocumentDto,
    @UploadedFile() file: Express.Multer.File
  ) {
    return this.compliance.uploadOwn(claims, id, dto.documentType, file, { expiryDate: dto.expiryDate, note: dto.note });
  }

  @Get("documents/pending")
  pending(@CurrentClaims() claims: RequestClaims) {
    return this.compliance.listPending(claims);
  }

  @Post("documents/:documentId/review")
  review(@CurrentClaims() claims: RequestClaims, @Param("documentId") documentId: string, @Body() dto: ReviewDocumentDto) {
    return this.compliance.review(claims, documentId, dto.decision, dto.note);
  }

  @Get("documents/required")
  required(@CurrentClaims() claims: RequestClaims) {
    return this.compliance.getRequired(claims);
  }

  @Put("documents/required")
  setRequired(@CurrentClaims() claims: RequestClaims, @Body() dto: RequiredDocumentsDto) {
    return this.compliance.setRequired(claims, dto.documentTypes);
  }

  @Get(`${EMPLOYEE_ID}/document-checklist`)
  checklist(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.compliance.checklist(claims, id);
  }

  @Get(`${EMPLOYEE_ID}/photo`)
  async photo(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Res() res: Response) {
    const photo = await this.compliance.photo(claims, id);
    // No photo is a normal state (most people have none), so answer "no content" rather than a 404 that clutters every browser console.
    if (!photo) {
      res.status(204).end();
      return;
    }
    res.setHeader("Content-Type", photo.mimeType);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(photo.buffer);
  }
}
