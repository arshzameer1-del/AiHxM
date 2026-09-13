import { Module } from "@nestjs/common";
import { FILE_STORAGE } from "./file-storage.interface";
import { LocalFileStorageService } from "./local-file-storage.service";

@Module({
  providers: [{ provide: FILE_STORAGE, useClass: LocalFileStorageService }],
  exports: [FILE_STORAGE],
})
export class FileStorageModule {}
