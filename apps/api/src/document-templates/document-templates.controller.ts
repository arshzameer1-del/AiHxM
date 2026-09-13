import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DocumentTemplatesService } from "./document-templates.service";
import { CreateDocumentTemplateDto, RenderDocumentDto } from "./dto/document-template.dto";

@Controller("document-templates")
@UseGuards(SessionGuard)
export class DocumentTemplatesController {
  constructor(private readonly documentTemplates: DocumentTemplatesService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateDocumentTemplateDto) {
    return this.documentTemplates.createTemplate(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.documentTemplates.listTemplates(claims);
  }

  @Post("render")
  render(@CurrentClaims() claims: RequestClaims, @Body() dto: RenderDocumentDto) {
    return this.documentTemplates.render(claims, dto.templateKey, dto.record);
  }
}
