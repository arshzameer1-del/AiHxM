import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type { PlatformBranding } from "@aihxm/shared-types";

/** Never carries a real user's claims — see tenant-context.ts's doc comment on `is_service`. */
const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "platform-branding" };

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBranding(row: any | undefined): PlatformBranding {
  return {
    hasLogo: Boolean(row?.logo_storage_path),
    updatedAt: row?.updated_at?.toISOString ? row.updated_at.toISOString() : row?.updated_at ?? new Date(0).toISOString(),
  };
}

/**
 * The platform's own logo (migration 0046_platform_branding.sql) — same
 * FileStorageService/upload shape as CompaniesService's TM-015 branding,
 * for exactly one thing (there is only one platform) instead of one row
 * per tenant. Reads always run under SERVICE_CLAIMS regardless of caller —
 * a real logo image isn't sensitive, and this is what lets the same data
 * serve three completely different pages: the Platform Admin's own
 * settings screen, the default (non-tenant) /login, and the small "Powered
 * by AIHXM" credit on every tenant's own subdomain login page. Only the
 * WRITE methods take the caller's real claims, so PlatformAdminGuard is
 * what actually gates who can change it.
 */
@Injectable()
export class PlatformBrandingService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  async getBranding(): Promise<PlatformBranding> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query("SELECT logo_storage_path, updated_at FROM platform_branding WHERE id = true");
      return rowToBranding(result.rows[0]);
    });
  }

  async downloadLogoAsset(): Promise<{ buffer: Buffer; mimeType: string }> {
    return this.db.withClaims(SERVICE_CLAIMS, async (client) => {
      const result = await client.query(
        "SELECT logo_storage_path, logo_mime_type FROM platform_branding WHERE id = true"
      );
      const row = result.rows[0];
      if (!row?.logo_storage_path) throw new NotFoundException("No platform logo has been uploaded");
      const buffer = await this.fileStorage.read(row.logo_storage_path);
      return { buffer, mimeType: row.logo_mime_type ?? "application/octet-stream" };
    });
  }

  async uploadLogo(
    claims: RequestClaims,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number }
  ): Promise<PlatformBranding> {
    if (file.size > MAX_LOGO_BYTES) {
      throw new BadRequestException(`File exceeds the ${MAX_LOGO_BYTES / (1024 * 1024)}MB limit`);
    }
    if (!file.mimetype.startsWith("image/")) {
      throw new BadRequestException("The platform logo must be an image file");
    }

    return this.db.withClaims(claims, async (client) => {
      const stored = await this.fileStorage.save("platform", "branding", `logo-${file.originalname}`, file.buffer);
      const result = await client.query(
        `INSERT INTO platform_branding (id, logo_storage_path, logo_mime_type, updated_at)
         VALUES (true, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET
           logo_storage_path = EXCLUDED.logo_storage_path,
           logo_mime_type = EXCLUDED.logo_mime_type,
           updated_at = now()
         RETURNING logo_storage_path, updated_at`,
        [stored.storagePath, file.mimetype]
      );
      return rowToBranding(result.rows[0]);
    });
  }

  async removeLogo(claims: RequestClaims): Promise<PlatformBranding> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO platform_branding (id, logo_storage_path, logo_mime_type, updated_at)
         VALUES (true, NULL, NULL, now())
         ON CONFLICT (id) DO UPDATE SET logo_storage_path = NULL, logo_mime_type = NULL, updated_at = now()
         RETURNING logo_storage_path, updated_at`
      );
      return rowToBranding(result.rows[0]);
    });
  }
}
