import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { ScimAuthGuard, type ScimAuthedRequest } from "./scim-auth.guard";
import { ScimExceptionFilter } from "./scim-exception.filter";
import { ScimService } from "./scim.service";

/**
 * The RFC 7644 SCIM 2.0 data surface — everything a tenant's IdP SCIM
 * connector calls directly. `ScimAuthGuard` (not PlatformAdminGuard or
 * SessionGuard — see its own doc comment) is this controller's only
 * authentication, since there is no session JWT in this flow at all.
 * `ScimExceptionFilter` converts every thrown error into RFC 7644 §3.12's
 * error shape, which a real IdP's SCIM connector parses specifically.
 *
 * A higher `@Throttle` limit than this codebase's other public routes: a
 * periodic full-directory reconciliation sync from even a small tenant's
 * IdP can legitimately be dozens of calls in a short burst, unlike a
 * human clicking a login link.
 */
@Controller("scim/v2/:companySlug")
@UseGuards(ScimAuthGuard)
@UseFilters(ScimExceptionFilter)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  @Get("ServiceProviderConfig")
  serviceProviderConfig() {
    return this.scim.serviceProviderConfig();
  }

  @Get("ResourceTypes")
  resourceTypes() {
    return this.scim.resourceTypes();
  }

  @Get("Schemas")
  schemas() {
    return this.scim.schemas();
  }

  @Get("Users")
  listUsers(
    @Param("companySlug") companySlug: string,
    @Query("filter") filter: string | undefined,
    @Query("startIndex") startIndex: string | undefined,
    @Query("count") count: string | undefined,
    @Req() req: ScimAuthedRequest
  ) {
    return this.scim.listUsers(companySlug.toLowerCase(), req.scimCompanyId, filter, startIndex, count);
  }

  @Get("Users/:id")
  getUser(@Param("companySlug") companySlug: string, @Param("id") id: string, @Req() req: ScimAuthedRequest) {
    return this.scim.getUser(companySlug.toLowerCase(), req.scimCompanyId, id);
  }

  @Post("Users")
  @HttpCode(201)
  async createUser(
    @Param("companySlug") companySlug: string,
    @Body() body: Record<string, unknown>,
    @Req() req: ScimAuthedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    const user = await this.scim.createUser(companySlug.toLowerCase(), req.scimCompanyId, body ?? {});
    const meta = user.meta as { location?: string } | undefined;
    if (meta?.location) res.setHeader("Location", meta.location);
    return user;
  }

  @Put("Users/:id")
  replaceUser(
    @Param("companySlug") companySlug: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: ScimAuthedRequest
  ) {
    return this.scim.replaceUser(companySlug.toLowerCase(), req.scimCompanyId, id, body ?? {});
  }

  @Patch("Users/:id")
  patchUser(
    @Param("companySlug") companySlug: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: ScimAuthedRequest
  ) {
    return this.scim.patchUser(companySlug.toLowerCase(), req.scimCompanyId, id, body ?? {});
  }

  @Delete("Users/:id")
  @HttpCode(204)
  async deleteUser(@Param("id") id: string, @Req() req: ScimAuthedRequest) {
    await this.scim.deleteUser(req.scimCompanyId, id);
  }
}
