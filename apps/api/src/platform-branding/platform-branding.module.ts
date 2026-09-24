import { Module } from "@nestjs/common";
import { PlatformBrandingController } from "./platform-branding.controller";
import { PublicPlatformBrandingController } from "./public-platform-branding.controller";
import { PlatformBrandingService } from "./platform-branding.service";
import { FileStorageModule } from "../file-storage/file-storage.module";

@Module({
  imports: [FileStorageModule],
  controllers: [PlatformBrandingController, PublicPlatformBrandingController],
  providers: [PlatformBrandingService],
})
export class PlatformBrandingModule {}
