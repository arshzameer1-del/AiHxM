import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type { BrandingAssetSlot, CompanyStatus, PublicTenantBranding } from "@aihxm/shared-types";

/** Never carries a real user's claims — see tenant-context.ts's doc comment on `is_service`. */
const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "public-branding" };

// A company mid-deletion or long since walked away has no reason to keep
// showing its logo to the public internet — everything else (draft,
// trial, active, suspended, locked) still might have someone trying to
// sign in and land on this page, so branding stays visible for those.
const HIDDEN_STATUSES: CompanyStatus[] = ["archived", "churned"];

const BRANDING_STORAGE_KEY: Record<BrandingAssetSlot, string> = {
  logo: "logoStoragePath",
  favicon: "faviconStoragePath",
  "login-background": "loginBackgroundStoragePath",
};
const BRANDING_MIME_KEY: Record<BrandingAssetSlot, string> = {
  logo: "logoMimeType",
  favicon: "faviconMimeType",
  "login-background": "loginBackgroundMimeType",
};

/**
 * The public, no-session counterpart to CompaniesService's
 * uploadBrandingAsset/downloadBrandingAsset (TM-015) — same
 * company_config.branding jsonb blob and the same FileStorageService,
 * just reachable by anyone who lands on a tenant's own login URL instead
 * of gated behind PlatformAdminGuard. See migration
 * 0045_public_branding_access.sql for the RLS change this depends on.
 */
@Injectable()
export class PublicBrandingService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  private async findVisibleCompany(client: import("pg").PoolClient, slug: string) {
    const result = await client.query(
      `SELECT c.id, c.name, c.status, cc.branding
       FROM companies c
       JOIN company_config cc ON cc.company_id = c.id
       WHERE c.slug = $1`,
      [slug]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    if (HIDDEN_STATUSES.includes(row.status)) return null;
    return row;
  }

  async getBranding(slug: string): Promise<PublicTenantBranding> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const row = await this.findVisibleCompany(client, slug);
      if (!row) throw new NotFoundException("No such company");
      const branding = row.branding ?? {};
      return {
        slug,
        companyName: row.name,
        primaryColor: branding.primaryColor ?? undefined,
        secondaryColor: branding.secondaryColor ?? undefined,
        hasLogo: Boolean(branding.logoStoragePath),
        hasLoginBackground: Boolean(branding.loginBackgroundStoragePath),
        logoAlignment: branding.logoAlignment ?? "left",
        logoHeightPx: branding.logoHeightPx ?? 32,
        logoBackgroundColor: branding.logoBackgroundColor ?? undefined,
        loginBackgroundPositionX: branding.loginBackgroundPositionX ?? "center",
        loginBackgroundPositionY: branding.loginBackgroundPositionY ?? "center",
        loginCardWidthPx: branding.loginCardWidthPx ?? 384,
        loginCardPosition: branding.loginCardPosition ?? "center",
        loginCardBackgroundColor: branding.loginCardBackgroundColor ?? "#FFFFFF",
        loginCardOpacity: branding.loginCardOpacity ?? 100,
      };
    });
  }

  async getBrandingAsset(
    slug: string,
    slot: Extract<BrandingAssetSlot, "logo" | "login-background">
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const row = await this.findVisibleCompany(client, slug);
      if (!row) throw new NotFoundException("No such company");
      const branding = row.branding ?? {};
      const storagePath = branding[BRANDING_STORAGE_KEY[slot]];
      if (!storagePath) throw new NotFoundException(`No ${slot} has been uploaded for this tenant`);
      const mimeType = branding[BRANDING_MIME_KEY[slot]] ?? "application/octet-stream";
      const buffer = await this.fileStorage.read(storagePath);
      return { buffer, mimeType };
    });
  }
}
