import { Module } from "@nestjs/common";
import { PublicBrandingController } from "./public-branding.controller";
import { PublicBrandingService } from "./public-branding.service";
import { FileStorageModule } from "../file-storage/file-storage.module";

@Module({
  imports: [FileStorageModule],
  controllers: [PublicBrandingController],
  providers: [PublicBrandingService],
})
export class PublicBrandingModule {}
