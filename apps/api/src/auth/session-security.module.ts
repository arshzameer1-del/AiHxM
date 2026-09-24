import { Global, Module } from "@nestjs/common";
import { SessionSecurityService } from "./session-security.service";

/**
 * Global, same rationale as DatabaseModule/CacheModule: PlatformAdminGuard
 * and SessionGuard are referenced by class (`@UseGuards(PlatformAdminGuard)`)
 * from dozens of feature modules that don't import AuthModule — with zero
 * constructor dependencies that worked by accident (Nest just calls `new
 * PlatformAdminGuard()` inline). The moment the guard gained a real
 * constructor dependency (SessionSecurityService), every one of those
 * modules needed to resolve it locally and failed
 * ("SessionSecurityService not part of the current CompaniesModule").
 * `@Global()` here — registered once, by AuthModule importing this module
 * — makes it resolvable from any module's injector without touching every
 * feature module that happens to use these guards.
 */
@Global()
@Module({
  providers: [SessionSecurityService],
  exports: [SessionSecurityService],
})
export class SessionSecurityModule {}
