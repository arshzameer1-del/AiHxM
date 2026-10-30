import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AssistantController } from "./assistant.controller";
import { AssistantService } from "./assistant.service";

@Module({ imports: [EntitlementsModule], controllers: [AssistantController], providers: [AssistantService], exports: [AssistantService] })
export class AssistantModule {}
