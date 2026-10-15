import { Global, Module } from "@nestjs/common";
import { BackgroundJobsService } from "./background-jobs.service";

@Global()
@Module({ providers: [BackgroundJobsService], exports: [BackgroundJobsService] })
export class BackgroundJobsModule {}
